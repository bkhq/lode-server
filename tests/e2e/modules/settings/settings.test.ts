import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface SettingRow { key: string; value: string }

describe("/api/settings (admin only)", () => {
  it("admin can list / put / get / delete a setting", async () => {
    const admin = await getClient("admin@example.com", "admin");

    const before = await admin.json<{ data: SettingRow[] }>("/api/settings");
    expect(Array.isArray(before.data)).toBe(true);

    const key = `e2e.test.${Date.now()}`;
    await admin.raw(`/api/settings/${key}`, {
      method: "PUT",
      body: { value: "yes" },
    });

    const got = await admin.json<{ data: SettingRow }>(`/api/settings/${key}`);
    expect(got.data.value).toBe("yes");

    await admin.raw(`/api/settings/${key}`, { method: "DELETE" });
    const gone = await admin.raw(`/api/settings/${key}`);
    expect(gone.status).toBe(404);
  });

  it("non-admin cannot read settings (403)", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.raw("/api/settings");
    expect(res.status).toBe(403);
  });
});
