/**
 * One paired Mac in Settings (I-164, doc §5.5): its name, status and address; Rename (this
 * phone's own name for it, I-138), Pair Again when its token was refused, Disconnect (forgets it
 * and its token), and a read-only view of its AI settings (I-155: another device's settings are
 * view-only), and a Local Models row (I-196: load/unload models on it). `/settings/devices/:envId`.
 */
import { useSignal } from "@preact/signals";
import { ChevronLeft } from "lucide-preact";
import { Navigate, useNavigate, useParams } from "react-router";
import { sameModel, type ModelRef } from "@glade/protocol";
import { connectionFor } from "@glade/app-core/state/env-registry";
import { environmentAddress } from "@glade/app-core/state/environments";
import { remoteStateOf } from "@glade/app-core/state/remote-status";
import { removeSavedEnvironment, savedEnvironments, setEnvironmentAlias } from "@glade/app-core/state/saved-environments";
import { isUsable, loadedCount, localModelsOf } from "@glade/app-core/state/local-models";
import { agentDefaultsOf, agentModelsOf, modelsForHarness, quickTasksModelOf, visibleModelsOf } from "@glade/app-core/state/store";
import { paths } from "~/app/routes";
import { canRetryMac, macStatusHint, macStatusShort, macStatusTitle, retryMac } from "~/lib/mac-status";
import { ListGroup, ListRow, NavBar, NavIconButton, PhoneButton, PhoneInput, Screen, ScreenBody, Sheet } from "~/ui/phone";
import { ConfirmSheet } from "~/ui/phone-extra";

/** Models listed before "Show All". */
const MODEL_LIMIT = 8;

export function DeviceScreen() {
  const { envId = "" } = useParams();
  const navigate = useNavigate();
  const renaming = useSignal(false);
  const draft = useSignal("");
  const confirmDisconnect = useSignal(false);
  const allModels = useSignal(false);

  const saved = savedEnvironments.value.find((e) => e.id === envId);
  if (!saved) return <Navigate to={paths.settings()} replace />;
  const conn = connectionFor(envId);
  const ownName = conn?.info.value?.name ?? saved.name;
  const name = conn?.name.value ?? saved.alias ?? saved.name;
  const state = remoteStateOf(envId);
  const address = conn ? environmentAddress(conn) : (saved.urls[0] ?? "");

  const saveName = () => {
    setEnvironmentAlias(envId, draft.value);
    renaming.value = false;
  };
  const disconnect = () => {
    confirmDisconnect.value = false;
    removeSavedEnvironment(envId);
    navigate(paths.settings(), { replace: true });
  };

  return (
    <Screen grouped>
      <NavBar
        title={name}
        left={
          <NavIconButton label="Settings" onClick={() => navigate(paths.settings())}>
            <ChevronLeft size={26} />
          </NavIconButton>
        }
      />
      <ScreenBody class="pt-2">
        <ListGroup>
          <ListRow
            title="Name"
            detail={name}
            chevron
            onClick={() => {
              draft.value = saved.alias ?? "";
              renaming.value = true;
            }}
          />
          <ListRow title="Status" detail={<span data-testid="device-status">{macStatusShort(state)}</span>} />
          <ListRow title="Address" detail={address} />
        </ListGroup>

        {state === "needs-pairing" && (
          <ListGroup footer={`${name} no longer accepts this iPhone. Share it again from the Mac and scan its code.`}>
            <ListRow title="Pair Again…" tone="accent" onClick={() => navigate(paths.connect())} />
          </ListGroup>
        )}
        {canRetryMac(state) && (
          <ListGroup header={macStatusTitle(state, name)} footer={macStatusHint(state, name)}>
            <ListRow title="Retry" tone="accent" onClick={() => retryMac(envId)} />
          </ListGroup>
        )}

        {state === "connected" && (
          <ListGroup footer={`Load and unload models in ${name}'s llama-server.`}>
            <ListRow title="Local Models" detail={localModelsDetail(envId)} chevron onClick={() => navigate(paths.localModels(envId))} />
          </ListGroup>
        )}

        <AiSettings envId={envId} name={name} allModels={allModels.value} onShowAll={() => (allModels.value = true)} />

        <ListGroup footer={`This iPhone forgets ${name} and its sign-in. To use it again, pair it again.`}>
          <ListRow title="Disconnect…" tone="danger" onClick={() => (confirmDisconnect.value = true)} />
        </ListGroup>
      </ScreenBody>

      <Sheet
        open={renaming.value}
        onClose={() => (renaming.value = false)}
        title="Rename"
        action={
          <PhoneButton kind="plain" onClick={saveName}>
            Save
          </PhoneButton>
        }
      >
        <form
          class="px-4 pt-1 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveName();
          }}
        >
          <PhoneInput aria-label="Device name" placeholder={ownName} value={draft.value} autoFocus onInput={(e) => (draft.value = (e.currentTarget as HTMLInputElement).value)} />
          <p class="px-4 pt-2 text-[13px] text-fg-muted">Only this iPhone uses this name. Leave it empty to use “{ownName}”.</p>
        </form>
      </Sheet>

      <ConfirmSheet
        open={confirmDisconnect.value}
        title={`Disconnect ${name}?`}
        message="Its chats disappear from this iPhone. Nothing is deleted on the Mac."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onClose={() => (confirmDisconnect.value = false)}
      />
    </Screen>
  );
}

/** The Mac's agents and models, view-only (from its connection's shell). */
function AiSettings({ envId, name, allModels, onShowAll }: { envId: string; name: string; allModels: boolean; onShowAll: () => void }) {
  const shell = connectionFor(envId)?.shell;
  const footer = `View only. Change these on ${name} in Glade → Settings.`;
  if (!shell || !shell.initialized.value || remoteStateOf(envId) !== "connected") {
    return (
      <ListGroup header="AI Settings">
        <ListRow title={<span class="text-fg-muted">Connect to see {name}'s AI settings.</span>} />
      </ListGroup>
    );
  }
  const settings = shell.settings.value;
  const harnesses = shell.harnesses.value ?? [];
  const all = shell.models.value;
  const models = visibleModelsOf(shell);
  const nameOf = (ref: ModelRef | null | undefined, list = all) => (ref ? (list.find((m) => sameModel(m, ref))?.name ?? ref.id) : null);
  const quick = quickTasksModelOf(shell);
  const labelOf = (id: string) => harnesses.find((h) => h.id === id)?.label ?? id;
  const quickName = quick ? `${harnesses.length > 1 ? `${labelOf(quick.harness)} · ` : ""}${nameOf(quick.model, modelsForHarness(all, quick.harness))}` : "Automatic";
  // I-198: model settings are per agent (agents that choose their own model have none).
  const withModels = harnesses.filter((h) => h.capabilities.models !== false);
  const shown = allModels ? models : models.slice(0, MODEL_LIMIT);
  return (
    <>
      <ListGroup header="Agents">
        {harnesses.length === 0 ? (
          <ListRow title={<span class="text-fg-muted">No agents reported</span>} />
        ) : (
          harnesses.map((h) => <ListRow key={h.id} title={h.label} detail={h.isDefault ? "Default" : undefined} />)
        )}
        <ListRow title="Sub-agents" detail={settings.agent.subagents ? "On" : "Off"} />
        <ListRow title="Quick Tasks Model" detail={quickName} />
      </ListGroup>
      {withModels.map((h, i) => {
        const own = agentModelsOf(shell, h.id);
        const list = modelsForHarness(all, h.id);
        const agentDefault = nameOf(agentDefaultsOf(h.id, envId)?.model, list);
        return (
          <ListGroup key={h.id} header={withModels.length > 1 ? `${h.label} Models` : "Models"} footer={i === withModels.length - 1 ? footer : undefined}>
            <ListRow title="Default Model" detail={nameOf(own.defaultModel, list) ?? (agentDefault ? `Agent default (${agentDefault})` : "Agent default")} />
            <ListRow title="Thinking" detail={capitalize(own.defaultThinkingLevel)} />
            <ListRow title="Sub-agent Model" detail={nameOf(own.subagentModel, list) ?? "Same as the chat"} />
          </ListGroup>
        );
      })}
      {withModels.length === 0 && (
        <ListGroup footer={footer}>
          <ListRow title={<span class="text-fg-muted">No model settings</span>} />
        </ListGroup>
      )}
      <ListGroup header={`Available Models (${models.length})`}>
        {models.length === 0 && <ListRow title={<span class="text-fg-muted">None</span>} />}
        {shown.map((m) => (
          <ListRow key={`${m.provider}/${m.id}`} title={m.name} subtitle={m.provider} />
        ))}
        {!allModels && models.length > MODEL_LIMIT && <ListRow title={`Show All ${models.length}`} tone="accent" onClick={onShowAll} />}
      </ListGroup>
    </>
  );
}

/** "2 loaded", "Not running", nothing before the Mac said. */
function localModelsDetail(envId: string): string | undefined {
  const lm = localModelsOf(envId);
  if (!lm) return undefined;
  if (!lm.reachable) return "Not running";
  if (!isUsable(lm)) return "Not usable";
  return `${loadedCount(lm)} loaded`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
