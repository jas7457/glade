/**
 * Starts the shared client core with **zero local environments** (I-164, doc §4.4): the iPhone
 * runs no server; every environment is a paired Mac from the saved list, tokens from the
 * Keychain. "Remote access" (the master switch, I-132) is always on here: it's the only kind of
 * access the phone has, and it lives on the device.
 */
import { startEnvironments } from "@/state/environments";
import { remoteMaster, setRemoteMaster } from "@/state/remote-master";
import { setSecretStore } from "@/state/saved-environments";
import { iphoneSecretStore } from "~/lib/secrets";
import { startPhoneAppearance } from "~/state/theme";

export async function bootIphone(): Promise<void> {
  setSecretStore(iphoneSecretStore());
  if (!remoteMaster.value) await setRemoteMaster(true);
  startPhoneAppearance();
  await startEnvironments({ localBaseUrl: null });
}
