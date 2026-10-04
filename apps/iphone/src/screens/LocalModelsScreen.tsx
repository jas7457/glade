/**
 * Local Models of one paired Mac (I-196): its llama-server's models with status, size, context
 * and the chats using them, Load / Unload / Cancel, memory used vs the Mac's GPU budget, and
 * setup help when the model server isn't running. Same logic as the desktop panel
 * (`useLocalModels`), drawn with the phone's grouped lists; confirmations are bottom sheets.
 * `/settings/devices/:envId/local-models`.
 */
import { useSignal } from "@preact/signals";
import { ChevronLeft, RefreshCw } from "lucide-preact";
import { Navigate, useNavigate, useParams } from "react-router";
import type { LocalModel } from "@glade/protocol";
import { CopyableCode, Meter, Spinner, StatusDot } from "@glade/app-core/ui";
import { STATUS_LABEL, rowAction, useLocalModels, type AskFn } from "@glade/app-core/features/local-models/use-local-models";
import { STATUS_TONE } from "@glade/app-core/features/local-models/LocalModelsPanel";
import { LLAMA_SERVER_COMMAND, backendLine, isUsable, formatContext, formatGB, memoryUse, usedByLabel, wouldOverflow, type ModelWarning } from "@glade/app-core/state/local-models";
import { connectionFor } from "@glade/app-core/state/env-registry";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { paths } from "~/app/routes";
import { ListGroup, ListRow, NavBar, NavIconButton, PhoneButton, Screen, ScreenBody } from "~/ui/phone";
import { ActionRow, ConfirmSheet } from "~/ui/phone-extra";

interface Asking {
  warning: ModelWarning;
  kind: "load" | "unload";
  resolve: (ok: boolean) => void;
}

export function LocalModelsScreen() {
  const { envId = "" } = useParams();
  const navigate = useNavigate();
  const asking = useSignal<Asking | null>(null);
  const ask: AskFn = (warning, kind) => new Promise((resolve) => (asking.value = { warning, kind, resolve }));
  const lm = useLocalModels(envId, ask);
  const saved = savedEnvironments.value.find((e) => e.id === envId);
  if (!saved) return <Navigate to={paths.settings()} replace />;
  const name = connectionFor(envId)?.name.value ?? saved.alias ?? saved.name;
  const { state } = lm;
  const settle = (ok: boolean) => {
    const current = asking.value;
    asking.value = null;
    current?.resolve(ok);
  };

  return (
    <Screen grouped>
      <NavBar
        title="Local Models"
        left={
          <NavIconButton label={name} onClick={() => navigate(paths.device(envId))}>
            <ChevronLeft size={26} />
          </NavIconButton>
        }
        right={
          <NavIconButton label="Refresh" onClick={() => void lm.refresh()}>
            {lm.refreshing ? <Spinner size={20} /> : <RefreshCw size={20} />}
          </NavIconButton>
        }
      />
      <ScreenBody class="pt-2">
        {!state ? (
          <ListGroup header={name}>
            <ListRow title={<span class="text-fg-muted">{lm.fetchError ?? "Checking…"}</span>} />
          </ListGroup>
        ) : (
          <>
            <ListGroup header={backendLine(state)}>
              {isUsable(state) ? (
                <MemoryRow state={state} />
              ) : (
                <ActionRow
                  title={state.error ?? "llama-server isn't answering."}
                  lines={[
                    "Start llama-server in router mode on the Mac:",
                    <CopyableCode key="cmd" code={LLAMA_SERVER_COMMAND} class="mt-1" />,
                    `Glade looks for it at ${state.url}. Change the address on ${name} in Glade → Settings → Local Models.`,
                  ]}
                />
              )}
            </ListGroup>
            {isUsable(state) && (
              <ListGroup header="Models" footer={state.maxLoaded ? `llama-server keeps at most ${state.maxLoaded} loaded.` : undefined}>
                {state.models.length === 0 && <ListRow title={<span class="text-fg-muted">No models in llama-server's models folder</span>} />}
                {state.models.map((m) => (
                  <PhoneModelRow
                    key={m.id}
                    model={m}
                    pending={lm.pending(m)}
                    mayNotFit={rowAction(m) === "load" && wouldOverflow(state, m)}
                    onLoad={() => void lm.load(m)}
                    onUnload={() => void lm.unload(m)}
                  />
                ))}
              </ListGroup>
            )}
          </>
        )}
      </ScreenBody>
      <ConfirmSheet
        open={!!asking.value}
        title={asking.value?.warning.title ?? ""}
        message={asking.value?.warning.message}
        confirmLabel={asking.value?.warning.confirmLabel ?? "OK"}
        destructive={asking.value?.kind === "unload"}
        onConfirm={() => settle(true)}
        onClose={() => settle(false)}
      />
    </Screen>
  );
}

function MemoryRow({ state }: { state: Parameters<typeof memoryUse>[0] }) {
  const memory = memoryUse(state);
  return (
    <ActionRow
      title={memory.label}
      lines={[
        <Meter
          key="meter"
          label="Memory used by loaded models"
          percent={memory.percent}
          tone={memory.over ? "critical" : memory.percent >= 85 ? "warning" : "normal"}
          class="mt-1.5 mb-1"
        />,
      ]}
    />
  );
}

function PhoneModelRow({ model, pending, mayNotFit, onLoad, onUnload }: { model: LocalModel; pending: boolean; mayNotFit: boolean; onLoad: () => void; onUnload: () => void }) {
  const details = [model.sizeBytes ? formatGB(model.sizeBytes) : null, formatContext(model.contextLength), usedByLabel(model)].filter(Boolean).join(" · ");
  const action = rowAction(model);
  const status = STATUS_LABEL[model.status];
  const tone = STATUS_TONE[model.status];
  const label = action === "load" ? "Load" : action === "cancel" ? "Cancel" : "Unload";
  return (
    <ActionRow
      testId="local-model"
      title={model.name}
      lines={[
        status ? (
          <span class="inline-flex items-center gap-1.5">
            {model.status === "loading" ? <Spinner size={12} /> : tone && <StatusDot tone={tone} />}
            {status}
          </span>
        ) : null,
        details || null,
        model.status === "failed" && model.error ? <span class="text-danger">{model.error}</span> : null,
        mayNotFit ? <span class="text-warning">May not fit in memory</span> : null,
      ]}
      trailing={
        <PhoneButton
          kind={action === "load" ? "plain" : "danger"}
          disabled={pending}
          aria-label={`${action === "cancel" ? "Cancel loading" : label} ${model.name}`}
          onClick={action === "load" ? onLoad : onUnload}
        >
          {pending && <Spinner size={14} />}
          {label}
        </PhoneButton>
      }
    />
  );
}
