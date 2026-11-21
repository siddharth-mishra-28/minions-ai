import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Provider } from '@/lib/types';
import { Button, Field, Input, Select, cn, toast } from '@/components/ui';

export const PRESETS = [
  { id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  { id: 'anthropic', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { id: 'azure', label: 'Azure OpenAI', type: 'azure', baseUrl: 'https://<resource>.openai.azure.com', model: '' },
  { id: 'openrouter', label: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { id: 'ollama', label: 'Ollama (local)', type: 'openai', baseUrl: 'http://localhost:11434/v1', model: '' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', type: 'openai', baseUrl: '', model: '' },
] as const;

interface FormState { name: string; type: string; baseUrl: string; apiKey: string; defaultModel: string; wireApi: string; azureApiVersion: string }
const empty = (p: (typeof PRESETS)[number]): FormState => ({ name: p.label === 'Custom (OpenAI-compatible)' ? '' : p.label, type: p.type, baseUrl: p.baseUrl, apiKey: '', defaultModel: p.model, wireApi: '', azureApiVersion: '' });

/** Add/edit a model provider; tests the connection and discovers models before/after saving. */
export function ProviderForm({ existing, onSaved, onCancel, submitLabel = 'Save provider', firstRun }: {
  existing?: Provider; onSaved?: (p: Provider) => void; onCancel?: () => void; submitLabel?: string; firstRun?: boolean;
}) {
  const [preset, setPreset] = useState<string>(existing ? 'custom' : 'openai');
  const [f, setF] = useState<FormState>(existing
    ? { name: existing.name, type: existing.type, baseUrl: existing.baseUrl, apiKey: '', defaultModel: existing.defaultModel ?? '', wireApi: existing.wireApi ?? '', azureApiVersion: existing.azureApiVersion ?? '' }
    : empty(PRESETS[0]));
  const [saved, setSaved] = useState<Provider | undefined>(existing);
  const [models, setModels] = useState<string[]>([]);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const body = () => ({
    name: f.name.trim(), type: f.type, baseUrl: f.baseUrl.trim(), defaultModel: f.defaultModel.trim() || null,
    ...(f.apiKey ? { apiKey: f.apiKey } : {}), wireApi: f.wireApi || null, azureApiVersion: f.azureApiVersion || null,
    ...(!saved && firstRun ? { makeDefault: true } : {}),
  });
  const save = useApiMutation(
    () => (saved
      ? api<Provider>(`/api/providers/${saved.id}`, { method: 'PATCH', body: body() })
      : api<Provider>('/api/providers', { method: 'POST', body: body() })),
    { invalidate: [qk.providers, qk.bootstrap] },
  );
  // Probe-only: never persists, so testing can never advance the flow on its own.
  const [testing, setTesting] = useState(false);
  const probe = async () => {
    setTesting(true);
    try {
      const r = saved
        ? await api<{ ok: boolean; models: string[]; message: string }>(`/api/providers/${saved.id}/test`, { method: 'POST' })
        : await api<{ ok: boolean; models: string[]; message: string }>('/api/providers/test', {
            method: 'POST',
            body: { type: f.type, baseUrl: f.baseUrl.trim(), ...(f.apiKey ? { apiKey: f.apiKey } : {}), ...(f.defaultModel.trim() ? { model: f.defaultModel.trim() } : {}) },
          });
      setModels(r.models ?? []);
      if (!f.defaultModel && r.models?.[0]) set('defaultModel', r.models[0]);
      setTest({ ok: true, message: r.message || `Connected. ${r.models?.length ?? 0} model(s) available.` });
      toast.ok('Connection verified');
    } catch (e) {
      // Failure is shown inline only — no toast, no navigation.
      setTest({ ok: false, message: errMsg(e) });
    } finally { setTesting(false); }
  };
  const submit = () => save.mutate(undefined, {
    onError: (e) => toast.error(errMsg(e)),
    onSuccess: async (p) => {
      setSaved(p);
      toast.ok('Provider saved');
      onSaved?.(p);
    },
  });
  const valid = f.name.trim() && f.baseUrl.trim() && (saved || f.apiKey);

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {!existing && (
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map((p) => (
            <button type="button" key={p.id} onClick={() => { setPreset(p.id); setF(empty(p)); setTest(null); setModels([]); }}
              className={cn('rounded-lg border px-3 py-2 text-left text-sm transition-colors', preset === p.id ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40')}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Display name"><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="My OpenAI" /></Field>
        <Field label="API type">
          <Select value={f.type} onChange={(e) => set('type', e.target.value)}>
            <option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="azure">Azure OpenAI</option>
          </Select>
        </Field>
      </div>
      <Field label="Base URL"><Input value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.example.com/v1" className="font-mono text-xs" /></Field>
      <Field label="API key" hint={existing ? 'Leave empty to keep the stored key. Keys are stored in the encrypted vault and never shown again.' : 'Stored in the encrypted credential vault and never shown again.'}>
        <Input type="password" autoComplete="off" value={f.apiKey} onChange={(e) => set('apiKey', e.target.value)} placeholder={existing?.hasKey ? '••••••••••••' : 'sk-…'} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default model" hint={models.length ? `${models.length} models discovered` : 'Test the connection to list available models.'}>
          {models.length ? (
            <Select value={f.defaultModel} onChange={(e) => set('defaultModel', e.target.value)}>
              {!models.includes(f.defaultModel) && f.defaultModel && <option value={f.defaultModel}>{f.defaultModel}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          ) : <Input value={f.defaultModel} onChange={(e) => set('defaultModel', e.target.value)} placeholder="gpt-4.1" />}
        </Field>
        {f.type === 'azure'
          ? <Field label="Azure API version"><Input value={f.azureApiVersion} onChange={(e) => set('azureApiVersion', e.target.value)} placeholder="2024-10-21" /></Field>
          : <Field label="Wire API" hint="Leave on automatic unless your endpoint requires it."><Select value={f.wireApi} onChange={(e) => set('wireApi', e.target.value)}><option value="">Automatic</option><option value="completions">Chat completions</option><option value="responses">Responses</option></Select></Field>}
      </div>
      {test && (
        <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', test.ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-danger/30 bg-danger/10 text-danger')}>
          {test.ok ? <CheckCircle2 className="mt-0.5 size-4" /> : <XCircle className="mt-0.5 size-4" />}<span>{test.message}</span>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="button" disabled={!valid || testing} loading={testing} onClick={() => void probe()}>Test connection</Button>
        <Button type="submit" variant="primary" disabled={!valid} loading={save.isPending}>{submitLabel}</Button>
      </div>
    </form>
  );
}
