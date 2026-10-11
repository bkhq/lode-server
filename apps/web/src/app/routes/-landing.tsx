import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Check, KeyRound, Languages, Package, ShieldCheck, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { ModeToggle } from "@/shared/components/mode-toggle";
import { Button } from "@/shared/components/ui/button";
import { APP_DISPLAY_NAME } from "@/shared/lib/branding";
import { BASE_PATH } from "@/shared/lib/http";
import { cn } from "@/shared/lib/utils";
import { Code } from "./-landing-code";

// Keeps a literal `${` in the snippets below out of template syntax.
const D = "$";

// Plain links: at the origin root the router has no base prefix, so a router
// link would not reach the console under BASE_PATH.
const CONSOLE = `${BASE_PATH}/overview`;

// The lode of the logo. The one colour on the page that is not a theme token.
const ORE = "#F2B441";

const LINK_BASE = "inline-flex items-center justify-center rounded-lg text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const PRIMARY_LINK = `${LINK_BASE} h-10 bg-primary px-5 text-primary-foreground hover:bg-primary/90`;
const OUTLINE_LINK = `${LINK_BASE} h-10 border px-5 hover:bg-muted`;
const NAV_LINK = "text-sm text-muted-foreground transition-colors hover:text-foreground";
const TEXT_LINK = "font-mono text-xs text-primary underline-offset-4 hover:underline";

const NAV = ["features", "how", "download", "publish", "install"] as const;

const FEATURES: readonly { readonly key: "packages" | "signed" | "ci" | "tokens"; readonly icon: LucideIcon }[] = [
  { key: "packages", icon: Package },
  { key: "signed", icon: ShieldCheck },
  { key: "ci", icon: Workflow },
  { key: "tokens", icon: KeyRound },
];

const STEPS = ["create", "publish", "run"] as const;

const LODE_REPO = "https://github.com/bkhq/lode";
const LODE_RELEASES = `${LODE_REPO}/releases/latest`;
const LODE_IMAGE = "docker.io/bkhq/lode";

/** The release archives of lode; each holds the `lode` and `lode-cli` binaries. */
const LODE_BUILDS = [
  { key: "linuxX64", file: "lode-linux-x64.tar.gz" },
  { key: "linuxArm64", file: "lode-linux-arm64.tar.gz" },
  { key: "macArm64", file: "lode-darwin-arm64.tar.gz" },
  { key: "macX64", file: "lode-darwin-x64.tar.gz" },
] as const;

const LODE_INSTALL = [
  `curl -fsSL ${LODE_RELEASES}/download/lode-linux-x64.tar.gz \\`,
  "  | sudo tar -xz -C /usr/local/bin lode lode-cli",
  "lode-cli --version",
].join("\n");

const LODE_DOCKERFILE = [
  "FROM debian:stable-slim              # or whatever your app needs",
  `COPY --from=${LODE_IMAGE}:latest /usr/bin/lode /usr/bin/lode`,
  "ENTRYPOINT [\"/usr/bin/lode\"]",
].join("\n");
const PUBLISH_STEPS = ["package", "token", "key", "publish", "ci"] as const;
const INSTALL_STEPS = ["config", "trust", "private", "run"] as const;

/** What a package looks like in the registry: versions newest first, channels pointing into them. */
const RELEASES: readonly { readonly version: string; readonly channel?: "stable" | "beta" }[] = [
  { version: "1.5.0-rc.1", channel: "beta" },
  { version: "1.4.2", channel: "stable" },
  { version: "1.4.1" },
  { version: "1.4.0" },
];

function publishCode(registry: string): Partial<Record<(typeof PUBLISH_STEPS)[number], string>> {
  return {
    key: "lode-cli keygen",
    publish: [
      "LODE_REGISTRY_TOKEN=pat_... lode-cli publish \\",
      `  --registry ${registry} \\`,
      "  --package <namespace>/myapp --version 1.4.2 --channel stable \\",
      "  --key-env LODE_SIGNING_KEY \\",
      "  dist/myapp-linux-x64.tar.gz dist/myapp-linux-arm64.tar.gz",
    ].join("\n"),
    ci: [
      "- name: Publish",
      "  env:",
      `    LODE_REGISTRY_TOKEN: ${D}{{ secrets.LODE_REGISTRY_TOKEN }}`,
      `    LODE_SIGNING_KEY: ${D}{{ secrets.LODE_SIGNING_KEY }}`,
      "  run: |",
      "    lode-cli publish \\",
      `      --registry ${registry} \\`,
      `      --package "${D}{{ vars.LODE_PACKAGE }}" \\`,
      `      --version "${D}{GITHUB_REF_NAME#v}" \\`,
      "      --key-env LODE_SIGNING_KEY \\",
      "      dist/*",
    ].join("\n"),
  };
}

function installCode(origin: string): Record<(typeof INSTALL_STEPS)[number], string> {
  return {
    config: [
      "[global]",
      "app = \"myapp\"                          # the package slug",
      "",
      "[update]",
      `manifest = "${origin}/r/<namespace>/myapp/manifest.json"`,
      "asset    = \"myapp-linux-x64.tar.gz\"    # the file this host installs",
      "channel  = \"stable\"",
      "policy   = \"auto\"                      # off | check | auto",
      "",
      "[command]",
      "run = \"./myapp\"",
    ].join("\n"),
    trust: [
      "[trust]",
      "require_signature = \"enforce\"",
      "trusted_keys = [\"<key_id>:<public-key>\"]",
    ].join("\n"),
    private: [
      "[http]",
      `headers = ["Authorization: Bearer ${D}{LODE_REGISTRY_TOKEN}"]`,
    ].join("\n"),
    run: [
      "docker run --rm \\",
      "  -v \"$PWD/lode.toml:/srv/lode/lode.toml:ro\" \\",
      `  ${LODE_IMAGE}:latest`,
    ].join("\n"),
  };
}

/** One part of the page: a full-width band with the content held to the page width. */
function Band({ id, tinted, className, children }: {
  readonly id?: string;
  readonly tinted?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section id={id} className={cn("scroll-mt-14 border-b border-border/60", tinted && "bg-muted/40")}>
      <div className={cn("mx-auto w-full max-w-5xl px-4 py-16 sm:py-20", className)}>{children}</div>
    </section>
  );
}

function BandHeading({ title, lead }: { readonly title: string; readonly lead?: string }) {
  return (
    <header className="max-w-2xl space-y-3">
      <h2 className="text-3xl font-semibold tracking-tight">{title}</h2>
      {lead && <p className="text-lg text-muted-foreground">{lead}</p>}
    </header>
  );
}

/** The hero's picture: a package as the registry holds it, the stable channel marked with the logo's ore. */
function ReleaseStack() {
  const { t } = useTranslation("home");
  return (
    <figure className="w-full max-w-sm">
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="font-mono text-sm">k3x9m2ab/myapp</span>
          <span className="text-xs text-muted-foreground">{t("stack.asset")}</span>
        </div>
        <ul>
          {RELEASES.map(({ version, channel }) => (
            <li
              key={version}
              className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
              style={channel === "stable" ? { boxShadow: `inset 3px 0 0 ${ORE}` } : undefined}
            >
              <span className={cn("font-mono text-sm", channel !== "stable" && "text-muted-foreground")}>{version}</span>
              {channel && (
                <span
                  className="rounded-full border px-2 py-0.5 text-xs"
                  style={channel === "stable" ? { borderColor: ORE } : undefined}
                >
                  {channel}
                </span>
              )}
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Check className="size-3.5" />
                {t("stack.signed")}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <figcaption className="mt-3 text-sm text-muted-foreground">{t("stack.caption")}</figcaption>
    </figure>
  );
}

/** A numbered run of steps, each with its explanation and, where it has one, the text to copy. */
function Walkthrough<K extends string>({ group, steps, code }: {
  readonly group: "publish" | "install";
  readonly steps: readonly K[];
  readonly code: Partial<Record<K, string>>;
}) {
  const { t } = useTranslation("home");
  return (
    <ol className="mt-10 space-y-10">
      {steps.map((step, i) => (
        <li key={step} className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-10">
          <div className="space-y-2">
            <h3 className="flex items-baseline gap-3 text-lg font-semibold">
              <span className="text-sm font-normal text-muted-foreground tabular-nums">{i + 1}</span>
              {t(`${group}.${step}.title`)}
            </h3>
            <p className="text-muted-foreground lg:pl-6">{t(`${group}.${step}.body`)}</p>
          </div>
          {code[step] && <Code label={t("copy")}>{code[step]}</Code>}
        </li>
      ))}
    </ol>
  );
}

/** The public landing page: what the registry is, how to publish to it, how to install from it. */
export function Landing() {
  const { t, i18n } = useTranslation("home");
  const other = i18n.language.startsWith("zh") ? "en" : "zh";
  const origin = window.location.origin;

  return (
    <div id="top" className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <a href="#top" className="flex items-center gap-2 font-semibold">
            <Logo className="size-7" />
            {APP_DISPLAY_NAME}
          </a>
          <nav className="hidden items-center gap-5 md:flex" aria-label={t("nav.label")}>
            {NAV.map(item => (
              <a key={item} href={`#${item}`} className={NAV_LINK}>{t(`nav.${item}`)}</a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void i18n.changeLanguage(other)} aria-label={t("nav.language")}>
              <Languages className="size-4" />
              {other === "zh" ? "中文" : "English"}
            </Button>
            <ModeToggle />
            <a href={CONSOLE} className={`${LINK_BASE} ml-1 h-8 bg-primary px-3 text-primary-foreground hover:bg-primary/90`}>{t("nav.console")}</a>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Band className="grid items-center gap-12 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="space-y-6">
            <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">{t("hero.title")}</h1>
            <p className="max-w-xl text-lg text-muted-foreground">{t("hero.lead")}</p>
            <div className="flex flex-wrap gap-3">
              <a href={CONSOLE} className={PRIMARY_LINK}>{t("hero.start")}</a>
              <a href="#publish" className={OUTLINE_LINK}>{t("hero.howToPublish")}</a>
            </div>
          </div>
          <ReleaseStack />
        </Band>

        <Band id="features" tinted>
          <BandHeading title={t("features.title")} />
          <dl className="mt-10 grid gap-x-12 gap-y-10 sm:grid-cols-2">
            {FEATURES.map(({ key, icon: Icon }) => (
              <div key={key} className="flex gap-4">
                <Icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
                <div className="space-y-1.5">
                  <dt className="font-semibold">{t(`features.${key}.title`)}</dt>
                  <dd className="text-muted-foreground">{t(`features.${key}.body`)}</dd>
                </div>
              </div>
            ))}
          </dl>
        </Band>

        <Band id="how">
          <BandHeading title={t("steps.title")} lead={t("steps.lead")} />
          <ol className="mt-10 grid gap-8 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step} className="space-y-2 border-t-2 pt-4" style={i === STEPS.length - 1 ? { borderColor: ORE } : undefined}>
                <p className="text-sm text-muted-foreground tabular-nums">{i + 1}</p>
                <h3 className="font-semibold">{t(`steps.${step}.title`)}</h3>
                <p className="text-muted-foreground">{t(`steps.${step}.body`)}</p>
              </li>
            ))}
          </ol>
        </Band>

        <Band id="download" tinted>
          <BandHeading title={t("download.title")} lead={t("download.lead")} />
          <div className="mt-10 grid items-start gap-10 lg:grid-cols-2">
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">{t("download.binary.title")}</h3>
              <p className="text-muted-foreground">{t("download.binary.body")}</p>
              <Code label={t("copy")}>{LODE_INSTALL}</Code>
              <ul className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {LODE_BUILDS.map(({ key, file }) => (
                  <li key={key} className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-2">
                    <span className="text-muted-foreground">{t(`download.builds.${key}`)}</span>
                    <a className={TEXT_LINK} href={`${LODE_RELEASES}/download/${file}`}>{file}</a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">{t("download.image.title")}</h3>
              <p className="text-muted-foreground">{t("download.image.body")}</p>
              <Code label={t("copy")}>{LODE_DOCKERFILE}</Code>
              <dl className="space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-2">
                  <dt className="text-muted-foreground">{t("download.links.repo")}</dt>
                  <dd><a className={TEXT_LINK} href={LODE_REPO} target="_blank" rel="noreferrer">github.com/bkhq/lode</a></dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-2">
                  <dt className="text-muted-foreground">{t("download.links.releases")}</dt>
                  <dd><a className={TEXT_LINK} href={LODE_RELEASES} target="_blank" rel="noreferrer">{t("download.links.releasesLabel")}</a></dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-2">
                  <dt className="text-muted-foreground">{t("download.links.image")}</dt>
                  <dd><a className={TEXT_LINK} href="https://hub.docker.com/r/bkhq/lode" target="_blank" rel="noreferrer">{LODE_IMAGE}</a></dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-2">
                  <dt className="text-muted-foreground">{t("download.links.server")}</dt>
                  <dd><a className={TEXT_LINK} href="https://github.com/bkhq/lode-server" target="_blank" rel="noreferrer">github.com/bkhq/lode-server</a></dd>
                </div>
              </dl>
            </div>
          </div>
          <p className="mt-8 max-w-2xl text-sm text-muted-foreground">{t("download.note")}</p>
        </Band>

        <Band id="publish">
          <BandHeading title={t("publish.title")} lead={t("publish.lead")} />
          <Walkthrough group="publish" steps={PUBLISH_STEPS} code={publishCode(`${origin}${BASE_PATH}`)} />
          <ul className="mt-10 max-w-2xl list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            <li>{t("publish.notes.rerun")}</li>
            <li>{t("publish.notes.size")}</li>
            <li>{t("publish.notes.immutable")}</li>
          </ul>
        </Band>

        <Band id="install" tinted>
          <BandHeading title={t("install.title")} lead={t("install.lead")} />
          <Walkthrough group="install" steps={INSTALL_STEPS} code={installCode(origin)} />
          <ul className="mt-10 max-w-2xl list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            <li>{t("install.notes.rollback")}</li>
            <li>{t("install.notes.unsigned")}</li>
            <li>{t("install.notes.rate")}</li>
          </ul>
        </Band>

        <Band className="flex flex-wrap items-center justify-between gap-6">
          <div className="max-w-xl space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">{t("closing.title")}</h2>
            <p className="text-muted-foreground">{t("closing.body")}</p>
          </div>
          <a href={CONSOLE} className={PRIMARY_LINK}>{t("closing.cta")}</a>
        </Band>
      </main>

      <footer>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Logo className="size-5" />
            {t("footer.tagline")}
          </span>
          <a className="hover:text-foreground" href={LODE_REPO} target="_blank" rel="noreferrer">{t("footer.lode")}</a>
          <a className="hover:text-foreground" href="#download">{t("nav.download")}</a>
          {/* For assistants: how to publish to and install from this registry, in one text file. */}
          <a className="hover:text-foreground" href="/llms.txt">llms.txt</a>
        </div>
      </footer>
    </div>
  );
}
