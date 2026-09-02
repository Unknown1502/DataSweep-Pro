import { useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, KeyRound, Sparkles } from 'lucide-react';
import { connectionId, rememberKey } from '../../lib/agent/key-vault';
import {
  PROVIDERS,
  providerById,
  providerForKey,
  type ModelConnection,
  type ProviderId,
} from '../../lib/agent/providers';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Alert, Input, Label, Select } from '../ui/misc';

/**
 * Connect a chat model.
 *
 * Every provider offered here was tested from a browser on this origin first.
 * A provider without CORS fails with `TypeError: Failed to fetch`, which is
 * indistinguishable from being offline — so listing one the browser cannot
 * reach would produce a bug report rather than a working feature.
 *
 * There is no base-URL field. The key the user pastes is theirs, and where it
 * gets sent is not a decision to leave open.
 */
/** "an OpenAI key", not "a OpenAI key". */
function article(label: string): string {
  return /^[AEIOU]/i.test(label) ? 'an' : 'a';
}

export function AddModelDialog({
  open,
  onOpenChange,
  onAdded,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (connection: ModelConnection) => void;
  existing: readonly ModelConnection[];
}) {
  const [providerId, setProviderId] = useState<ProviderId>('anthropic');
  const [model, setModel] = useState(PROVIDERS[0]!.models[0]!);
  const [custom, setCustom] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const provider = useMemo(() => providerById(providerId), [providerId]);
  const usingCustom = model === '__custom__';
  const chosenModel = usingCustom ? custom.trim() : model;

  function pickProvider(id: ProviderId) {
    setProviderId(id);
    // A model id from one provider is meaningless at another, so it resets
    // rather than carrying over and failing at request time.
    setModel(providerById(id).models[0]!);
    setCustom('');
    setError(null);
  }

  function connect() {
    const key = apiKey.trim();
    if (!chosenModel) {
      setError('Enter a model id.');
      return;
    }
    if (!key) {
      setError('Enter an API key.');
      return;
    }
    // A soft check, not a validation: it catches a key pasted into the wrong
    // provider, which otherwise surfaces much later as a bare 401.
    const looksLike = providerForKey(key);
    if (looksLike && looksLike.id !== providerId) {
      setError(
        `That looks like ${article(looksLike.label)} ${looksLike.label} key, not ` +
          `${provider.label}. Switch the provider above, or paste ` +
          `${article(provider.label)} ${provider.label} key.`,
      );
      return;
    }
    if (!looksLike && provider.keyPrefix) {
      setError(
        `${provider.label} keys usually start with "${provider.keyPrefix}". ` +
          'Check you pasted the right one.',
      );
      return;
    }

    const id = connectionId(providerId, chosenModel);
    if (existing.some((c) => c.id === id)) {
      setError('That model is already connected.');
      return;
    }

    // The key goes to the vault; the connection object never carries it.
    rememberKey(id, key);
    onAdded({
      id,
      provider: providerId,
      model: chosenModel,
      addedAt: new Date().toISOString(),
    });

    setApiKey('');
    setCustom('');
    setError(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add chat model"
        description="Runs the same tools and the same approval gate as every other agent here."
        className="max-w-110"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={connect} disabled={!chosenModel || !apiKey.trim()}>
              <Sparkles />
              Connect
            </Button>
          </div>
        }
      >
        <div className="space-y-3.5 p-4">
          <div>
            <Label htmlFor="model-provider">Provider</Label>
            <Select
              id="model-provider"
              value={providerId}
              onChange={(e) => pickProvider(e.target.value as ProviderId)}
              className="mt-1 w-full"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            {provider.note && (
              <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">{provider.note}</p>
            )}
          </div>

          <div>
            <Label htmlFor="model-name">Model</Label>
            <Select
              id="model-name"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mt-1 w-full font-mono"
            >
              {provider.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {/* Model ids change faster than any list ships, so typing one is
                  always available rather than being a fallback for outages. */}
              <option value="__custom__">Other — type a model id</option>
            </Select>

            {usingCustom && (
              <Input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="provider-specific model id"
                autoComplete="off"
                spellCheck={false}
                className="mt-2 font-mono"
                aria-label="Model id"
              />
            )}
          </div>

          <div>
            <Label htmlFor="model-key">API key</Label>
            <Input
              id="model-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider.keyPrefix ? `${provider.keyPrefix}…` : 'your API key'}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 font-mono"
            />
            <a
              href={provider.keysUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 inline-flex items-center gap-1 text-[12px] text-primary underline underline-offset-2"
            >
              Get a {provider.label} key
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </div>

          <Alert tone="neutral">
            <KeyRound />
            <span>
              Held in memory for this tab only — never written to storage, never placed in a tool
              argument, and gone when you reload. Requests go from your browser straight to{' '}
              {provider.label}; nothing passes through a server of ours, because there isn’t one.
            </span>
          </Alert>

          {error && (
            <Alert tone="danger">
              <AlertTriangle />
              {error}
            </Alert>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
