import {
  createRule,
  findShadowedRules,
  type MockRule,
  type DecoyConfig,
  type TrafficEntry,
} from '@mocksmith/core';
import {
  MousePointerClick,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { FirstRun } from '@/ui/components/FirstRun';
import { Header } from '@/ui/components/Header';
import { PageScopeStrip } from '@/ui/components/PageScopeStrip';
import { PreviewPane } from '@/ui/components/PreviewPane';
import { RuleEditor } from '@/ui/components/RuleEditor';
import { RuleList } from '@/ui/components/RuleList';
import { TrafficTable } from '@/ui/components/TrafficTable';
import { Button } from '@/ui/components/ui/button';
import { EmptyState } from '@/ui/components/ui/empty-state';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  useDefaultLayout,
  usePanelRef,
} from '@/ui/components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import { Tooltip } from '@/ui/components/ui/tooltip';
import { useToast } from '@/ui/components/ui/toast';
import { useConfig } from '@/ui/hooks/useConfig';
import { useSurfaceWidth } from '@/ui/hooks/useSurfaceWidth';
import { useStats } from '@/ui/hooks/useStats';
import { useTheme } from '@/ui/hooks/useTheme';
import { useScopeTabId, useTraffic } from '@/ui/hooks/useTraffic';
import { getShortcutRoot, originalTarget } from '@/ui/lib/roots';
import { togglePanel } from '@/ui/lib/messaging';
import { summarizeScope } from '@/ui/lib/scope';
import {
  countEnabledRules,
  duplicateRule,
  moveRule,
  moveRuleToIndex,
  moveRuleToTop,
  removeRule,
  ruleFromTrafficEntry,
  setMasterEnabled,
  setRuleEnabled,
  upsertRule,
} from '@/ui/lib/rules';
import { cn } from '@/ui/lib/utils';

export type ViewKind = 'popup' | 'tab' | 'panel';

/**
 * Supplied only by the floating panel, which owns its own position and size and
 * so has to own the two controls that change them.
 */
export interface PanelChrome {
  onClose: () => void;
  onCollapse: () => void;
  onDragPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

type Panel = 'rules' | 'traffic';

/** How long a just-changed row stays highlighted. Matches the flash animation. */
const FLASH_MS = 1000;

/**
 * Loading and failure only. Everything that needs a rule set lives in
 * `Surface`, which is mounted with a config that is already known to exist --
 * so no hook in it has to be written around a nullable config.
 */
export function App({ view, panelChrome }: { view: ViewKind; panelChrome?: PanelChrome }) {
  const { config, status, error, update, reload } = useConfig();

  if (config === null) {
    if (status === 'loading') return <LoadingState />;

    return (
      <EmptyState
        icon={TriangleAlert}
        title="Decoy could not start"
        description={
          error ??
          'The background worker did not respond. Reloading the extension usually clears this.'
        }
        action={
          <Button variant="primary" onClick={reload}>
            Try again
          </Button>
        }
        className="h-full"
      />
    );
  }

  return (
    <Surface
      view={view}
      config={config}
      error={error}
      update={update}
      panelChrome={panelChrome}
    />
  );
}

interface SurfaceProps {
  view: ViewKind;
  config: DecoyConfig;
  error: string | null;
  update: (next: DecoyConfig) => void;
  panelChrome?: PanelChrome;
}

function Surface({ view, config, error, update, panelChrome }: SurfaceProps) {
  const traffic = useTraffic();
  const { stats } = useStats();
  const { theme, setTheme } = useTheme();
  const activeTabId = useScopeTabId(view);
  // Measured off this surface, not the window: the floating panel is a window
  // within a window, and only its own width can decide how many panes fit.
  const [surfaceRef, surfaceWidth] = useSurfaceWidth<HTMLDivElement>();
  const isWide = surfaceWidth >= 768;
  const isExtraWide = surfaceWidth >= 1200;
  const toast = useToast();

  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('rules');
  /**
   * Which side panes are folded away. Mirrored into React state from the panel
   * group rather than owned here, because a pane also collapses by dragging its
   * separator to the edge, and a toggle that disagrees with the screen is worse
   * than no toggle.
   */
  const [listCollapsed, setListCollapsed] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const listPaneRef = usePanelRef();
  const previewPaneRef = usePanelRef();
  const [flashRuleId, setFlashRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MockRule | null>(null);
  const rulesFilterRef = useRef<HTMLInputElement>(null);
  const trafficFilterRef = useRef<HTMLInputElement>(null);

  const flash = useCallback((ruleId: string) => {
    setFlashRuleId(ruleId);
    setTimeout(() => {
      setFlashRuleId((current) => (current === ruleId ? null : current));
    }, FLASH_MS);
  }, []);

  const handleCreate = useCallback(() => {
    const rule = createRule(Date.now());
    update(upsertRule(config, rule, Date.now()));
    setSelectedRuleId(rule.id);
    setPanel('rules');
    flash(rule.id);
  }, [config, update, flash]);

  const handleMockRequest = useCallback(
    (entry: TrafficEntry) => {
      const rule = ruleFromTrafficEntry(entry, Date.now());
      update(upsertRule(config, rule, Date.now()));
      setSelectedRuleId(rule.id);
      // Never a silent tab change: the new row is selected, flashed and
      // scrolled to, so the switch explains itself.
      setPanel('rules');
      flash(rule.id);
    },
    [config, update, flash],
  );

  const handleDelete = useCallback(
    (ruleId: string) => {
      const removed = config.rules.find((rule) => rule.id === ruleId);
      const index = config.rules.findIndex((rule) => rule.id === ruleId);
      update(removeRule(config, ruleId));
      setSelectedRuleId((current) => (current === ruleId ? null : current));
      if (removed === undefined) return;

      // Undo instead of a confirm dialog: the cost lands on the rare mistake
      // rather than on every single deletion.
      toast.show('Rule deleted', {
        label: 'Undo',
        onAct: () => {
          update(
            moveRuleToIndex(upsertRule(config, removed, removed.updatedAt), removed.id, index),
          );
          setSelectedRuleId(removed.id);
          flash(removed.id);
        },
      });
    },
    [config, update, toast, flash],
  );

  /**
   * The popup is a fixed 780x600, so the keyboard is the fast path rather than
   * a power-user extra. Bare digits are ignored inside a text field, or typing
   * "1" into a url pattern would switch panels.
   */
  useEffect(() => {
    const onKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      const target = originalTarget(event);
      const inTextField =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        const field = panel === 'rules' ? rulesFilterRef.current : trafficFilterRef.current;
        field?.focus();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        handleCreate();
        return;
      }

      if (inTextField || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === '1') setPanel('rules');
      else if (event.key === '2') setPanel('traffic');
    };

    // Bound to the surface, not to `window`. The floating panel lives inside
    // somebody else's page, and a tool that swallows the host app's ⌘K is a
    // tool you have to close to use the thing you are debugging.
    const root = getShortcutRoot();
    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('keydown', onKeyDown);
    };
  }, [panel, handleCreate]);

  /**
   * A worker error used to insert a red bar between the tabs and the panel,
   * which shoved the whole list down at the exact moment something had gone
   * wrong. The toast layer is an overlay, so it says the same thing without
   * moving anything.
   */
  const reportedError = useRef<string | null>(null);
  useEffect(() => {
    if (error === null) {
      reportedError.current = null;
      return;
    }
    // Only once per distinct message: `update` sets the same error on every
    // failed write, and three identical toasts are not three problems.
    if (reportedError.current === error) return;
    reportedError.current = error;
    toast.show(error);
  }, [error, toast]);

  const shadows = useMemo(() => findShadowedRules(config.rules), [config.rules]);
  const scope = useMemo(
    () => summarizeScope(traffic.entries, activeTabId),
    [traffic.entries, activeTabId],
  );

  const now = () => Date.now();
  const selectedRule = config.rules.find((rule) => rule.id === selectedRuleId) ?? null;
  // Width decides, not which surface this is. The popup is wide enough for the
  // split now, and a 900px window has the same room whichever one it is.
  const useSplitLayout = isWide;
  // The split layout always has something in the editor pane; the drill-down
  // layout shows the list until a rule is picked.
  const editorRule = useSplitLayout ? (selectedRule ?? config.rules[0] ?? null) : selectedRule;
  const usePreviewPane = useSplitLayout && isExtraWide;
  // The tester belongs wherever the preview is not: collapsing the preview pane
  // has to hand it back rather than take it off the screen entirely.
  const previewVisible = usePreviewPane && !previewCollapsed;

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: usePreviewPane ? 'decoy-panes-3' : 'decoy-panes-2',
  });

  const togglePane = (ref: typeof listPaneRef) => {
    const pane = ref.current;
    if (pane === null) return;
    if (pane.isCollapsed()) pane.expand();
    else pane.collapse();
  };

  // The preview reads the draft, so it never shows the saved rule while the
  // form beside it shows something else.
  const previewRule = draft !== null && draft.id === editorRule?.id ? draft : editorRule;

  const list = (
    <RuleList
      rules={config.rules}
      stats={stats}
      shadows={shadows}
      selectedRuleId={editorRule?.id ?? null}
      flashRuleId={flashRuleId}
      filterRef={rulesFilterRef}
      onSelect={setSelectedRuleId}
      onToggle={(ruleId, enabled) => {
        update(setRuleEnabled(config, ruleId, enabled, now()));
      }}
      onMove={(ruleId, offset) => {
        update(moveRule(config, ruleId, offset));
      }}
      onMoveToTop={(ruleId) => {
        update(moveRuleToTop(config, ruleId));
      }}
      onMoveToIndex={(ruleId, index) => {
        update(moveRuleToIndex(config, ruleId, index));
      }}
      onDelete={handleDelete}
      onDuplicate={(ruleId) => {
        const result = duplicateRule(config, ruleId, now());
        update(result.config);
        if (result.newRuleId !== null) {
          setSelectedRuleId(result.newRuleId);
          flash(result.newRuleId);
        }
      }}
      onCreate={handleCreate}
    />
  );

  const editor = (rule: MockRule, withBack: boolean) => (
    <RuleEditor
      rule={rule}
      rules={config.rules}
      showMatchTester={!previewVisible}
      onDraftChange={setDraft}
      onSave={(next) => {
        update(upsertRule(config, next, now()));
        flash(next.id);
      }}
      onDelete={() => {
        handleDelete(rule.id);
      }}
      {...(withBack
        ? {
            onBack: () => {
              setSelectedRuleId(null);
            },
          }
        : {})}
    />
  );

  const rulesPanel =
    config.rules.length === 0 && config.enabled ? (
      <FirstRun
        onOpenTraffic={() => {
          setPanel('traffic');
        }}
        onCreateRule={handleCreate}
      />
    ) : useSplitLayout ? (
      <ResizablePanelGroup
        id="decoy-rules"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="list"
          panelRef={listPaneRef}
          collapsible
          collapsedSize={0}
          defaultSize={usePreviewPane ? '24' : '32'}
          minSize="15rem"
          maxSize="30rem"
          onResize={(size) => {
            setListCollapsed(size.inPixels === 0);
          }}
        >
          {list}
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* The only pane that cannot be folded away. Everything else on this
            screen is in service of what is in it. */}
        <ResizablePanel id="editor" minSize="20rem">
          {editorRule === null ? (
            <EmptyState
              icon={MousePointerClick}
              title="No rule selected"
              description="Pick a rule on the left, or create one, to edit how its requests are answered."
              className="h-full"
            />
          ) : (
            editor(editorRule, false)
          )}
        </ResizablePanel>

        {usePreviewPane && previewRule !== null ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              id="preview"
              panelRef={previewPaneRef}
              collapsible
              collapsedSize={0}
              defaultSize="24"
              minSize="16rem"
              maxSize="32rem"
              onResize={(size) => {
                setPreviewCollapsed(size.inPixels === 0);
              }}
            >
              <PreviewPane rule={previewRule} rules={config.rules} />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    ) : editorRule === null ? (
      list
    ) : (
      editor(editorRule, true)
    );

  return (
    <div ref={surfaceRef} className="flex h-full min-h-0 flex-1 flex-col bg-paper">
      <Header
        enabled={config.enabled}
        enabledRuleCount={countEnabledRules(config)}
        showOpenInTab={view === 'popup'}
        theme={theme}
        onThemeChange={setTheme}
        onToggle={(enabled) => {
          update(setMasterEnabled(config, enabled));
        }}
        {...(view === 'popup' && activeTabId !== null
          ? {
              onOpenPanel: () => {
                togglePanel(activeTabId)
                  .then(() => {
                    // The popup has done its job the moment the panel appears,
                    // and leaving it open would cover the thing it just opened.
                    window.close();
                  })
                  .catch(() => {
                    toast.show('This page does not allow extensions to run on it.');
                  });
              },
            }
          : {})}
        {...(panelChrome === undefined
          ? {}
          : {
              onClose: panelChrome.onClose,
              onCollapse: panelChrome.onCollapse,
              onDragPointerDown: panelChrome.onDragPointerDown,
            })}
      />

      {/* Always present, always one height. Pausing swaps the words and the
          button inside it; nothing below it moves. */}
      <PageScopeStrip
        enabled={config.enabled}
        scope={scope}
        ruleCount={config.rules.length}
        hasScope={activeTabId !== null}
        onResume={() => {
          update(setMasterEnabled(config, true));
        }}
      />

      <Tabs
        value={panel}
        onValueChange={(value) => {
          setPanel(value as Panel);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* The tabs and the view controls share one bar. The toggles are not
            tabs, so they sit outside the tablist rather than inside it. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-surface pr-2">
          <TabsList className="min-w-0 flex-1 border-b-0">
            <TabsTrigger value="rules">
              Rules
              {config.rules.length > 0 ? (
                <span className="ml-1.5 text-ink-muted">{config.rules.length}</span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="traffic">
              Traffic
              {traffic.entries.length > 0 ? (
                <span className="ml-1.5 text-ink-muted">{traffic.entries.length}</span>
              ) : null}
            </TabsTrigger>
          </TabsList>

          {panel === 'rules' && useSplitLayout ? (
            <PaneToggles
              listCollapsed={listCollapsed}
              previewCollapsed={previewCollapsed}
              showPreviewToggle={usePreviewPane}
              onToggleList={() => {
                togglePane(listPaneRef);
              }}
              onTogglePreview={() => {
                togglePane(previewPaneRef);
              }}
            />
          ) : null}
        </div>

        <TabsContent value="rules">
          {/* Desaturated rather than dimmed. Every gold switch and semantic pill
              goes grey, which is exactly the message, and no text drops below
              the contrast floor on the way there. */}
          <div className={cn('h-full min-h-0', config.enabled ? undefined : 'grayscale')}>
            {rulesPanel}
          </div>
        </TabsContent>

        <TabsContent value="traffic">
          <TrafficTable
            entries={traffic.entries}
            rules={config.rules}
            logWasCleared={traffic.dropped}
            filterRef={trafficFilterRef}
            onClear={traffic.clear}
            activeTabId={activeTabId}
            onMockRequest={handleMockRequest}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface PaneTogglesProps {
  listCollapsed: boolean;
  previewCollapsed: boolean;
  showPreviewToggle: boolean;
  onToggleList: () => void;
  onTogglePreview: () => void;
}

/**
 * Folds either side pane away, so the form in the middle can have the whole
 * window when a json body needs it.
 *
 * The icon states the outcome rather than the current state -- a closing panel
 * when the pane is open, an opening one when it is folded -- because that is
 * what a button promises. The label spells it out either way, since these are
 * two icons that differ by one chevron.
 */
function PaneToggles({
  listCollapsed,
  previewCollapsed,
  showPreviewToggle,
  onToggleList,
  onTogglePreview,
}: PaneTogglesProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip label={listCollapsed ? 'Show the rule list' : 'Hide the rule list'}>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggleList}
          aria-pressed={listCollapsed}
          aria-label={listCollapsed ? 'Show the rule list' : 'Hide the rule list'}
        >
          {listCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      </Tooltip>

      {showPreviewToggle ? (
        <Tooltip label={previewCollapsed ? 'Show the preview' : 'Hide the preview'}>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onTogglePreview}
            aria-pressed={previewCollapsed}
            aria-label={previewCollapsed ? 'Show the preview' : 'Hide the preview'}
          >
            {previewCollapsed ? <PanelRightOpen /> : <PanelRightClose />}
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full flex-col gap-2 p-3" aria-busy="true" aria-label="Loading rules">
      <div className="h-8 animate-pulse rounded-lg bg-sunk" />
      <div className="h-8 w-2/3 animate-pulse rounded-lg bg-sunk" />
      <div className="h-8 w-1/2 animate-pulse rounded-lg bg-sunk" />
    </div>
  );
}
