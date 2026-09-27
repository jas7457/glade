/**
 * Settings → Agents → ACP agents (I-119): add, edit and remove Agent Client Protocol agents
 * (name, command, arguments, environment). Each becomes its own agent in the new-chat picker.
 * Stored in `settings.harnesses.acp.agents`; none by default. Glade only starts an agent's
 * command when a chat with it gets a message.
 */
import { useEffect, useState } from "preact/hooks";
import { Pencil, Plus, Trash2 } from "lucide-preact";
import { acpAgentIdFor, type AcpAgentConfig } from "@glade/protocol";
import { Button, Dialog, FormGroup, FormRow, IconButton, TextArea, TextField, confirm } from "@/ui";
import { settings } from "@/state/store";
import { updateSettings } from "@/state/actions";
import { loadHarnesses } from "@/state/harnesses";

export const ACP_COST_NOTE = "Glade starts this command when you use it; it may use your account/subscription.";

/** Split an argument string like a shell does for simple cases: whitespace, "double" and 'single' quotes. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]!));
  return out;
}

/** Arguments back to text (quoting the ones with spaces or quotes). */
export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (a === "" || /[\s"']/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)).join(" ");
}

/** `KEY=value` lines → env. Returns the first invalid line as an error. */
export function parseEnv(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { env, error: `Not a KEY=value line: ${line}` };
    env[key] = line.slice(eq + 1);
  }
  return { env, error: null };
}

export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function agents(): AcpAgentConfig[] {
  return settings.value.harnesses.acp?.agents ?? [];
}

async function saveAgents(next: AcpAgentConfig[]): Promise<boolean> {
  const ok = await updateSettings({ harnesses: { acp: { agents: next } } });
  if (ok) await loadHarnesses();
  return ok;
}

export function AcpSettings() {
  const list = agents();
  const [editing, setEditing] = useState<AcpAgentConfig | "new" | null>(null);

  const remove = async (agent: AcpAgentConfig) => {
    const ok = await confirm({
      title: "Remove agent?",
      subject: agent.name,
      message: "will be removed from Glade. Its chats stay in the sidebar but can't continue until you add it again.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) await saveAgents(agents().filter((a) => a.id !== agent.id));
  };

  return (
    <>
      <FormGroup
        title="ACP agents"
        footer={
          <>
            Any agent that speaks the Agent Client Protocol (for example with an <span class="font-mono">--acp</span> flag or an{" "}
            <span class="font-mono">*-acp</span> adapter). Each one appears as its own agent for new chats. {ACP_COST_NOTE}
          </>
        }
        actions={
          <Button size="sm" variant="ghost" onClick={() => setEditing("new")}>
            <Plus size={12} />
            Add Agent
          </Button>
        }
      >
        {list.length === 0 && <FormRow label={<span class="text-fg-muted">No ACP agents yet.</span>} />}
        {list.map((agent) => (
          <FormRow
            key={agent.id}
            label={<span class="font-medium">{agent.name}</span>}
            description={<span class="font-mono text-[0.9rem] [overflow-wrap:anywhere]">{joinArgs([agent.command, ...agent.args])}</span>}
          >
            <IconButton size="sm" label={`Edit ${agent.name}`} onClick={() => setEditing(agent)}>
              <Pencil size={13} />
            </IconButton>
            <IconButton size="sm" label={`Remove ${agent.name}`} onClick={() => void remove(agent)}>
              <Trash2 size={13} />
            </IconButton>
          </FormRow>
        ))}
      </FormGroup>
      <AcpAgentDialog open={editing !== null} agent={editing === "new" ? null : editing} onOpenChange={(open) => !open && setEditing(null)} />
    </>
  );
}

export interface AcpAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this agent; `null` = add a new one. */
  agent: AcpAgentConfig | null;
}

export function AcpAgentDialog({ open, onOpenChange, agent }: AcpAgentDialogProps) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(agent?.name ?? "");
    setCommand(agent?.command ?? "");
    setArgs(joinArgs(agent?.args ?? []));
    setEnvText(formatEnv(agent?.env ?? {}));
    setBusy(false);
  }, [open, agent]);

  const env = parseEnv(envText);
  const valid = name.trim() !== "" && command.trim() !== "" && !env.error;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const current = agents();
    const next: AcpAgentConfig = {
      id: agent?.id ?? acpAgentIdFor(name, current.map((a) => a.id)),
      name: name.trim(),
      command: command.trim(),
      args: splitArgs(args),
      env: env.env,
    };
    const ok = await saveAgents(agent ? current.map((a) => (a.id === agent.id ? next : a)) : [...current, next]);
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={agent ? "Edit ACP agent" : "Add ACP agent"}
      description={ACP_COST_NOTE}
      width={520}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        document.getElementById("acp-name")?.focus();
      }}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
            {agent ? "Save" : "Add agent"}
          </Button>
        </>
      }
    >
      <form
        class="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div class="flex flex-col gap-1.5">
          <label for="acp-name" class="font-medium">
            Name
          </label>
          <TextField id="acp-name" value={name} maxLength={60} placeholder="Gemini CLI" onInput={(e) => setName(e.currentTarget.value)} />
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="acp-command" class="font-medium">
            Command
          </label>
          <TextField id="acp-command" mono value={command} placeholder="gemini" onInput={(e) => setCommand(e.currentTarget.value)} />
          <p class="text-[0.92rem] text-fg-muted">A program on your PATH or an absolute path. It runs in the chat's folder.</p>
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="acp-args" class="font-medium">
            Arguments <span class="font-normal text-fg-muted">(optional)</span>
          </label>
          <TextField id="acp-args" mono value={args} placeholder="--experimental-acp" onInput={(e) => setArgs(e.currentTarget.value)} />
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="acp-env" class="font-medium">
            Environment <span class="font-normal text-fg-muted">(optional, one KEY=value per line)</span>
          </label>
          <TextArea
            id="acp-env"
            mono
            rows={3}
            value={envText}
            invalid={!!env.error}
            placeholder="GEMINI_MODEL=gemini-2.5-pro"
            onInput={(e) => setEnvText(e.currentTarget.value)}
          />
          {env.error && <p class="text-[0.92rem] text-danger">{env.error}</p>}
        </div>
      </form>
    </Dialog>
  );
}
