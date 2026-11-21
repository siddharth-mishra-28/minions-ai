import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, CheckCircle2, Rocket, Sparkles, Users, Workflow } from 'lucide-react';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Provider } from '@/lib/types';
import { ProviderForm } from '@/features/providers/ProviderForm';
import { Button, Card, ThemeToggle, cn, toast } from '@/components/ui';

type Mode = 'quick' | 'guided';
const STEPS = ['Welcome', 'Setup mode', 'Provider', 'Defaults', 'Done'];

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center justify-center gap-2" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div className={cn('flex size-6 items-center justify-center rounded-full text-[11px] font-semibold',
            i < step ? 'bg-accent text-accent-fg' : i === step ? 'border border-accent text-accent' : 'border border-border text-muted')}>
            {i < step ? <CheckCircle2 className="size-3.5" /> : i + 1}
          </div>
          {i < STEPS.length - 1 && <div className={cn('h-px w-6', i < step ? 'bg-accent' : 'bg-border')} />}
        </div>
      ))}
    </div>
  );
}

export default function Onboarding() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>('quick');
  const [provider, setProvider] = useState<Provider | null>(null);
  const [seed, setSeed] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [seeded, setSeeded] = useState<{ agents: string[]; teams: string[] } | null>(null);

  const done = useApiMutation(() => api('/api/settings', { method: 'PATCH', body: { onboarding: { completed: true } } }), { invalidate: [qk.bootstrap, qk.settings] });
  const finish = () => { done.mutate(undefined); nav('/chat'); };

  const runSeed = async () => {
    if (!seed) { setSeeded({ agents: [], teams: [] }); setStep(4); return; }
    setSeeding(true);
    try {
      const r = await api<{ seededAgents: string[]; seededTeams: { id: string; version: string }[] }>('/api/onboarding/seed', { method: 'POST' });
      setSeeded({ agents: r.seededAgents, teams: r.seededTeams.map((t) => `${t.id}@${t.version}`) });
      toast.ok('Starter content registered');
    } catch (e) {
      setSeeded({ agents: [], teams: [] });
      toast.error(`Seeding failed: ${(e as Error).message}`);
    } finally { setSeeding(false); setStep(4); }
  };

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-y-auto p-6">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      <div className="w-full max-w-2xl space-y-6">
        <Stepper step={step} />

        {step === 0 && (
          <div className="text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent text-xl font-bold text-accent-fg">M</span>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">Welcome to Minions Cockpit</h1>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              Assemble custom AI agents and agent teams from versioned definitions, run them on your own
              model provider, and watch every step audited. Five minutes to a working setup.
            </p>
            <div className="mt-6 grid grid-cols-3 gap-3 text-left text-xs text-muted">
              <div className="rounded-xl border border-border p-3"><Bot className="size-4 text-accent" /><p className="mt-1.5 font-medium text-fg">Custom agents</p><p className="mt-1">Goals, roles, tools and memory — all yours to define.</p></div>
              <div className="rounded-xl border border-border p-3"><Users className="size-4 text-accent" /><p className="mt-1.5 font-medium text-fg">Agent teams</p><p className="mt-1">Sequential or manager-led workflows over your agents.</p></div>
              <div className="rounded-xl border border-border p-3"><Workflow className="size-4 text-accent" /><p className="mt-1.5 font-medium text-fg">Auditable runs</p><p className="mt-1">Every tool call, message and artifact is on record.</p></div>
            </div>
            <div className="mt-6 flex justify-center gap-2">
              <Button variant="primary" onClick={() => setStep(1)}>Get started</Button>
              <Button variant="ghost" onClick={finish}>Skip for now</Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-center text-lg font-semibold">How do you want to set up?</h2>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => { setMode('quick'); setStep(2); }}
                className={cn('rounded-xl border p-4 text-left transition', mode === 'quick' ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40')}>
                <Rocket className="size-4 text-accent" />
                <p className="mt-2 text-sm font-medium">Quick setup</p>
                <p className="mt-1 text-xs text-muted">One provider, one key, tested before saving. Starter agents and the sample team are registered for you.</p>
              </button>
              <button onClick={() => { setMode('guided'); setStep(2); }}
                className={cn('rounded-xl border p-4 text-left transition', mode === 'guided' ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40')}>
                <Sparkles className="size-4 text-accent" />
                <p className="mt-2 text-sm font-medium">Guided tour</p>
                <p className="mt-1 text-xs text-muted">Everything in quick setup, plus a review of the default model and what gets seeded.</p>
              </button>
            </div>
            <div className="flex justify-center"><Button variant="ghost" onClick={() => setStep(0)}>Back</Button></div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <h2 className="text-center text-lg font-semibold">Connect a model provider</h2>
            <p className="text-center text-sm text-muted">Bring your own key — it is sealed in the local encrypted vault and never printed. <b>Test connection</b> never saves; only <b>Save and continue</b> does.</p>
            <Card className="p-6">
              <ProviderForm firstRun submitLabel="Save and continue"
                onSaved={(p) => { setProvider(p); if (mode === 'quick') void runSeed(); else setStep(3); }} />
            </Card>
            <div className="flex justify-center"><Button variant="ghost" onClick={() => setStep(1)}>Back</Button></div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <h2 className="text-center text-lg font-semibold">Starter content</h2>
            <Card className="p-6 space-y-4">
              <div>
                <p className="text-sm font-medium">Default model</p>
                <p className="mt-1 font-mono text-sm text-muted">{provider?.defaultModel ?? 'from your provider'} · {provider?.name}</p>
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
                <input type="checkbox" checked={seed} onChange={(e) => setSeed(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
                <span>
                  <span className="text-sm font-medium">Register the shipped role agents and the Software Delivery Team</span>
                  <span className="mt-1 block text-xs text-muted">Five role agents (manager, architect, requirements analyst, full-stack developer, QE engineer) and a published five-member delivery team — runnable immediately and easy to edit or clone.</span>
                </span>
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
                <Button variant="primary" disabled={seeding} loading={seeding} onClick={() => void runSeed()}>{seed ? 'Register and finish' : 'Finish'}</Button>
              </div>
            </Card>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-ok/15 text-ok"><CheckCircle2 className="size-7" /></span>
            <h2 className="text-lg font-semibold">You are set up</h2>
            <Card className="p-5 text-left text-sm">
              <div className="grid grid-cols-2 gap-y-2">
                <span className="text-muted">Provider</span><span>{provider?.name}</span>
                <span className="text-muted">Model</span><span className="font-mono">{provider?.defaultModel ?? '—'}</span>
                <span className="text-muted">Role agents</span><span>{seeded?.agents.length ? seeded.agents.join(', ') : 'none'}</span>
                <span className="text-muted">Teams</span><span>{seeded?.teams.length ? seeded.teams.join(', ') : 'none'}</span>
              </div>
            </Card>
            <Button variant="primary" onClick={finish}>Open the cockpit</Button>
          </div>
        )}
      </div>
    </div>
  );
}
