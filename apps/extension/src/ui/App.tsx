import { createRule, type MockRule, type TrafficEntry } from '@mocksmith/core';
import { MousePointerClick, TriangleAlert } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Header } from '@/ui/components/Header';
import { RuleEditor } from '@/ui/components/RuleEditor';
import { RuleList } from '@/ui/components/RuleList';
import { TrafficTable } from '@/ui/components/TrafficTable';
import { Button } from '@/ui/components/ui/button';
import { EmptyState } from '@/ui/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import { useConfig } from '@/ui/hooks/useConfig';
import { useMediaQuery } from '@/ui/hooks/useMediaQuery';
import { useActiveTabId, useTraffic } from '@/ui/hooks/useTraffic';
import {
  countEnabledRules,
  duplicateRule,
  moveRule,
  removeRule,
  ruleFromTrafficEntry,
  setMasterEnabled,
  setRuleEnabled,
  upsertRule,
} from '@/ui/lib/rules';

export type ViewKind = 'popup' | 'tab';

type Panel = 'rules' | 'traffic';

export function App({ view }: { view: ViewKind }) {
  const { config, status, error, update, reload } = useConfig();
  const traffic = useTraffic();
  const activeTabId = useActiveTabId(view === 'popup');
  const isWide = useMediaQuery('(min-width: 768px)');

  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('rules');

  const handleMockRequest = useCallback(
    (entry: TrafficEntry) => {
      if (config === null) return;
      const rule = ruleFromTrafficEntry(entry, Date.now());
      update(upsertRule(config, rule, Date.now()));
      setSelectedRuleId(rule.id);
      setPanel('rules');
    },
    [config, update],
  );

  if (status === 'loading' && config === null) {
    return <LoadingState />;
  }

  if (config === null) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState
          icon={TriangleAlert}
          title="Mocksmith could not start"
          description={
            error ??
            'The background worker did not respond. Reloading the extension usually clears this.'
          }
          action={
            <Button variant="primary" onClick={reload}>
              Try again
            </Button>
          }
          className="flex-1"
        />
      </div>
    );
  }

  const selectedRule = config.rules.find((rule) => rule.id === selectedRuleId) ?? null;
  const useSplitLayout = view === 'tab' && isWide;
  // The split layout always has something in the editor pane; the drill-down
  // layout shows the list until a rule is picked.
  const editorRule = useSplitLayout ? (selectedRule ?? config.rules[0] ?? null) : selectedRule;

  const now = () => Date.now();

  const list = (
    <RuleList
      rules={config.rules}
      selectedRuleId={editorRule?.id ?? null}
      onSelect={setSelectedRuleId}
      onToggle={(ruleId, enabled) => {
        update(setRuleEnabled(config, ruleId, enabled, now()));
      }}
      onMove={(ruleId, offset) => {
        update(moveRule(config, ruleId, offset));
      }}
      onDuplicate={(ruleId) => {
        const result = duplicateRule(config, ruleId, now());
        update(result.config);
        if (result.newRuleId !== null) setSelectedRuleId(result.newRuleId);
      }}
      onCreate={() => {
        const rule = createRule(now());
        update(upsertRule(config, rule, now()));
        setSelectedRuleId(rule.id);
      }}
    />
  );

  const editor = (rule: MockRule, withBack: boolean) => (
    <RuleEditor
      rule={rule}
      onSave={(next) => {
        update(upsertRule(config, next, now()));
      }}
      onDelete={() => {
        update(removeRule(config, rule.id));
        setSelectedRuleId(null);
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <Header
        enabled={config.enabled}
        enabledRuleCount={countEnabledRules(config)}
        showOpenInTab={view === 'popup'}
        onToggle={(enabled) => {
          update(setMasterEnabled(config, enabled));
        }}
      />

      {error !== null ? (
        <p role="alert" className="bg-danger px-3.5 py-1.5 text-[11px] font-medium text-white">
          {error}
        </p>
      ) : null}

      <Tabs
        value={panel}
        onValueChange={(value) => {
          setPanel(value as Panel);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="traffic">
            Traffic
            {traffic.entries.length > 0 ? (
              <span className="ml-1.5 text-ink-muted">
                {traffic.entries.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rules">
          {useSplitLayout ? (
            <div className="grid h-full min-h-0 grid-cols-[minmax(280px,360px)_1fr] divide-x divide-hairline">
              <div className="min-w-0">{list}</div>
              <div className="min-w-0">
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
              </div>
            </div>
          ) : editorRule === null ? (
            list
          ) : (
            editor(editorRule, true)
          )}
        </TabsContent>

        <TabsContent value="traffic">
          <TrafficTable
            entries={traffic.entries}
            onClear={traffic.clear}
            activeTabId={activeTabId}
            onMockRequest={handleMockRequest}
          />
        </TabsContent>
      </Tabs>
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
