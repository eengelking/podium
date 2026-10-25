// What a build knows about the versions, read from the variables scripts/build.mjs sets (see astro.config.mjs).
import { REPO } from "../../docs-nav.mjs";

export interface Version {
  line: string;
  label: string;
  latest: boolean;
  ref: string | null;
  base: string;
}

export const versions: Version[] = JSON.parse(process.env.DOCS_VERSIONS ?? "[]");
export const currentLine = process.env.DOCS_CURRENT ?? versions[0]?.line ?? "";
export const current: Version | undefined = versions.find((v) => v.line === currentLine) ?? versions[0];
export const latest: Version | undefined = versions.find((v) => v.latest);
export const base = process.env.DOCS_BASE ?? "/";
export const repoUrl = `https://github.com/${REPO}`;

/** The GitHub page that lists what this version changed. */
export const releaseUrl = !current || current.latest ? `${repoUrl}/releases/latest` : `${repoUrl}/releases/tag/${current.ref}`;

/** The address a repository file has at the version being read, for links in the footer. */
export const repoFile = (file: string) => `${repoUrl}/blob/${current?.ref ?? "main"}/${file}`;
