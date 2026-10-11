import type { BlobStore } from "./types";
import { isAbsolute, resolve } from "node:path";
import { ROOT_DIR } from "@/root";
import { createLocalBlobStore } from "./local";

/**
 * The two settings the registry reads. Declared structurally so the app's
 * `Config` can be passed as is.
 */
export interface BlobStoreConfig {
  /** `local` or the name of a registered store (`r2` on Workers). */
  REGISTRY_BLOB_DRIVER: string;
  /** Root of the local store. Resolved against the project root when relative. */
  REGISTRY_BLOB_LOCAL_ROOT: string;
}

const stores = new Map<string, BlobStore>();

/**
 * Make a store selectable by name. Last write wins. The Workers entry
 * registers the `PACKAGES` bucket as `r2` before the app boots.
 */
export function registerBlobStore(name: string, store: BlobStore): void {
  stores.set(name, store);
}

/**
 * The store named by `REGISTRY_BLOB_DRIVER`. The local store needs no
 * registration: it is created from `REGISTRY_BLOB_LOCAL_ROOT` on first use.
 * Throws for any other name that nothing registered — call it during module
 * init so a missing bucket binding fails the boot, not the first upload.
 */
export function getActiveBlobStore(config: BlobStoreConfig): BlobStore {
  const name = config.REGISTRY_BLOB_DRIVER;
  const registered = stores.get(name);
  if (registered) {
    return registered;
  }

  if (name === "local") {
    const root = config.REGISTRY_BLOB_LOCAL_ROOT;
    const store = createLocalBlobStore(isAbsolute(root) ? root : resolve(ROOT_DIR, root));
    stores.set(name, store);
    return store;
  }

  if (name === "r2") {
    throw new Error("REGISTRY_BLOB_DRIVER=r2 needs the PACKAGES R2 bucket binding, which this deployment does not have.");
  }

  const known = [...new Set(["local", ...stores.keys()])].sort().join(", ");
  throw new Error(`Unknown registry blob driver: '${name}'. Known: ${known}.`);
}

/** Test-only: forget every registered and lazily created store. */
export function __resetBlobStoresForTests(): void {
  stores.clear();
}
