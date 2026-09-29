/**
 * This server as an environment (I-123, design: docs/design/environments-and-store.md §3.3): its
 * permanent id (from the store, shared by every server on the data folder), its display name
 * (the machine name unless renamed) and what it can do. Served as `GET /api/environment`, sent
 * in shell snapshots and as `environment` pushes after a rename.
 */
import { execFileSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { SYNC_PROTOCOL, type BuildInfo, type EnvironmentInfo } from "@glade/protocol";
import { VERSION } from "../config.js";
import { currentBuild } from "./build-info.js";
import type { Store } from "../store/store.js";

/** Longest environment name accepted by a rename. */
export const MAX_ENVIRONMENT_NAME = 100;

export interface EnvironmentOptions {
  /** `process.platform` (tests). */
  platform?: NodeJS.Platform;
  /** `os.hostname()` (tests). */
  hostname?: string;
  /** The host user's home folder (tests). */
  home?: string;
  /** The machine's display name (tests). Default: `scutil --get ComputerName` on macOS, else the host name. */
  machineName?: () => string | null;
  /** The commit this server was built from (I-149; tests). Default: {@link currentBuild}. */
  build?: () => BuildInfo | null;
}

/** The macOS computer name ("Jason's Mac Studio"), or null when unavailable. */
export function macComputerName(): string | null {
  try {
    const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return name || null;
  } catch {
    return null;
  }
}

export class Environment {
  private readonly platform: NodeJS.Platform;
  private readonly hostname: string;
  private readonly home: string;
  private readonly machineNameSource: () => string | null;
  private machineName: string | null = null;
  readonly build: () => BuildInfo | null;

  constructor(
    private readonly store: Store,
    options: EnvironmentOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.hostname = options.hostname ?? hostname();
    this.home = options.home ?? homedir();
    this.build = options.build ?? currentBuild;
    this.machineNameSource = options.machineName ?? (() => (this.platform === "darwin" ? macComputerName() : null));
  }

  get id(): string {
    return this.store.environmentId;
  }

  /** The default name: the machine's name, else its host name without `.local`. Read once. */
  defaultName(): string {
    this.machineName ??= this.machineNameSource()?.trim() || this.hostname.replace(/\.local$/i, "") || "Glade";
    return this.machineName;
  }

  info(): EnvironmentInfo {
    const darwin = this.platform === "darwin";
    return {
      id: this.id,
      name: this.store.getEnvironmentName() ?? this.defaultName(),
      version: VERSION,
      protocol: SYNC_PROTOCOL,
      platform: this.platform,
      hostname: this.hostname,
      home: this.home,
      capabilities: {
        openIn: darwin,
        reveal: darwin,
        nativeFolderPicker: darwin,
        browse: true,
        // Device auth and pairing (I-125/I-126).
        remoteAccess: true,
      },
      build: this.build(),
    };
  }

  /** Rename; an empty name (or the machine name itself) goes back to following the machine name. */
  rename(name: string): EnvironmentInfo {
    const trimmed = name.trim();
    this.store.setEnvironmentName(trimmed && trimmed !== this.defaultName() ? trimmed : null);
    return this.info();
  }
}
