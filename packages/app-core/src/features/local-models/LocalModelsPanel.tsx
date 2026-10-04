/**
 * Local Models panel (I-196), desktop look: the model server of one environment's Mac (backend +
 * address, refresh, memory used vs that Mac's GPU budget) and its models with status, size,
 * context, which chats use them, and Load / Unload / Cancel. Works for any Mac, also another one
 * picked in Settings' device switcher (loading is an action, not a settings change). When the
 * model server can't be reached it shows why and how to start it. The iPhone renders the same
 * logic ({@link useLocalModels}) with its own list primitives.
 *
 *   <LocalModelsPanel envId={hostEnvId()} footer={<UrlField />} />
 */
import type { ComponentChildren } from "preact";
import { RefreshCw } from "lucide-preact";
import type { LocalModel, LocalModelsState } from "@glade/protocol";
import { Button, CopyableCode, FormGroup, FormRow, IconButton, Meter, Spinner, StatusDot, confirm, type StatusTone } from "@glade/app-core/ui";
import { LLAMA_SERVER_COMMAND, backendLine, isUsable, formatContext, formatGB, memoryUse, usedByLabel, wouldOverflow } from "@glade/app-core/state/local-models";
import { STATUS_LABEL, rowAction, useLocalModels, type AskFn } from "./use-local-models";

export interface LocalModelsPanelProps {
  /** The environment (Mac) whose model server to show; `null`/`undefined` = this one. */
  envId?: string | null;
  /** Rendered under the panel (Settings adds the Server URL field). */
  footer?: ComponentChildren;
  /** Where to change the address, under the setup help (default: just the address). */
  urlHint?: (url: string) => ComponentChildren;
}

const askDesktop: AskFn = (warning, kind) =>
  confirm({ title: warning.title, message: warning.message, confirmLabel: warning.confirmLabel, destructive: kind === "unload" });

export const STATUS_TONE: Record<LocalModel["status"], StatusTone | null> = {
  loaded: "on",
  loading: null,
  sleeping: "off",
  failed: "error",
  unloaded: null,
};

export function LocalModelsPanel({ envId, footer, urlHint }: LocalModelsPanelProps) {
  const lm = useLocalModels(envId, askDesktop);
  const { state } = lm;
  const refreshButton = (
    <IconButton label="Refresh" onClick={() => void lm.refresh()} disabled={lm.refreshing}>
      {lm.refreshing ? <Spinner /> : <RefreshCw />}
    </IconButton>
  );

  if (!state) {
    return (
      <div data-testid="local-models">
        <FormGroup>
          <FormRow
            label={lm.fetchError ? "Couldn't get the local models" : "Checking local models…"}
            description={lm.fetchError ?? undefined}
          >
            {lm.fetchError ? refreshButton : <Spinner />}
          </FormRow>
        </FormGroup>
        {footer}
      </div>
    );
  }

  const memory = memoryUse(state);
  const usable = isUsable(state);
  return (
    <div data-testid="local-models">
      <FormGroup>
        <FormRow label={backendLine(state)} description={usable ? undefined : state.reachable ? "Not usable" : "Not running"}>
          {refreshButton}
        </FormRow>
        {usable && (
          <FormRow label={<span class="tabular-nums">{memory.label}</span>} stacked>
            <Meter
              label="Memory used by loaded models"
              percent={memory.percent}
              tone={memory.over ? "critical" : memory.percent >= 85 ? "warning" : "normal"}
              class="w-full"
            />
          </FormRow>
        )}
      </FormGroup>

      {!usable ? (
        <SetupHelp state={state} urlHint={urlHint} />
      ) : state.models.length === 0 ? (
        <FormGroup title="Models">
          <FormRow label={<span class="text-fg-muted">No models in llama-server's models folder</span>} />
        </FormGroup>
      ) : (
        <FormGroup title="Models" footer={state.maxLoaded ? `llama-server keeps at most ${state.maxLoaded} loaded.` : undefined}>
          {state.models.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              pending={lm.pending(m)}
              mayNotFit={rowAction(m) === "load" && wouldOverflow(state, m)}
              onLoad={() => void lm.load(m)}
              onUnload={() => void lm.unload(m)}
            />
          ))}
        </FormGroup>
      )}
      {footer}
    </div>
  );
}

function SetupHelp({ state, urlHint }: { state: LocalModelsState; urlHint?: (url: string) => ComponentChildren }) {
  return (
    <FormGroup title={state.reachable ? "Can't use it" : "Not reachable"}>
      <FormRow
        stacked
        label={state.error ?? "llama-server isn't answering."}
        description={
          <div class="mt-1 flex flex-col gap-1.5">
            <span>Start llama-server in router mode:</span>
            <CopyableCode code={LLAMA_SERVER_COMMAND} />
            <span>{urlHint ? urlHint(state.url) : `Glade looks for it at ${state.url}.`}</span>
          </div>
        }
      />
    </FormGroup>
  );
}

interface ModelRowProps {
  model: LocalModel;
  pending: boolean;
  mayNotFit: boolean;
  onLoad: () => void;
  onUnload: () => void;
}

function ModelRow({ model, pending, mayNotFit, onLoad, onUnload }: ModelRowProps) {
  const details = [model.sizeBytes ? formatGB(model.sizeBytes) : null, formatContext(model.contextLength), usedByLabel(model)].filter(Boolean).join(" · ");
  const action = rowAction(model);
  const status = STATUS_LABEL[model.status];
  const tone = STATUS_TONE[model.status];
  return (
    <div data-testid="local-model" data-model={model.id} data-status={model.status}>
      <FormRow
        label={<span class="font-medium">{model.name}</span>}
        description={
          details || model.error || mayNotFit ? (
            <>
              {details && <span class="block tabular-nums">{details}</span>}
              {model.status === "failed" && model.error && <span class="block text-danger">{model.error}</span>}
              {mayNotFit && <span class="block text-warning">May not fit in memory</span>}
            </>
          ) : undefined
        }
      >
        {status && (
          <span class="flex items-center gap-1.5 text-fg-muted select-none">
            {model.status === "loading" ? <Spinner size={12} /> : tone && <StatusDot tone={tone} />}
            {status}
          </span>
        )}
        <Button
          size="sm"
          disabled={pending}
          aria-label={`${action === "load" ? "Load" : action === "cancel" ? "Cancel loading" : "Unload"} ${model.name}`}
          onClick={action === "load" ? onLoad : onUnload}
          class="min-w-[4.5rem]"
        >
          {pending && <Spinner size={12} />}
          {action === "load" ? "Load" : action === "cancel" ? "Cancel" : "Unload"}
        </Button>
      </FormRow>
    </div>
  );
}
