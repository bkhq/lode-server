import type { BackupContribution } from "@/modules/backup/registry";
import {
  registryAssets,
  registryChannels,
  registryDelegations,
  registryKeys,
  registryManifestSignatures,
  registryNamespaces,
  registryPackages,
  registryQuotas,
  registryRetiredVersions,
  registryRevocationLists,
  registryUploads,
  registryVersions,
} from "./schema";

// Table rows only: asset bytes live in the blob store and are not part of a
// database backup.
//
// `registry_token_grants` is left out on purpose. A grant points at an
// `api_tokens` row, and no backup carries those: restoring `users` deletes
// every user, which cascades to their tokens. A restored grant would then
// reference a token that no longer exists and the foreign key check at COMMIT
// would fail the whole import. Grants go the way of the tokens they narrow.
//
// `registry_instances` and `registry_instance_events` are reported telemetry,
// rebuilt by the next reports, and are left out as well.
export const registryBackupContribution: BackupContribution = {
  name: "registry",
  // Parents before children, so insert order alone satisfies the foreign keys.
  tables: [
    registryNamespaces,
    registryPackages,
    registryRetiredVersions,
    registryKeys,
    registryVersions,
    registryAssets,
    registryChannels,
    registryManifestSignatures,
    registryDelegations,
    registryRevocationLists,
    registryUploads,
    registryQuotas,
  ],
  // `policies` holds the owner tuple of every package.
  deps: ["users", "policies"],
};
