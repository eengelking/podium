import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// src/content/docs is written by scripts/build.mjs from ../docs, one version at a time; it is not edited by hand.
export const collections = { docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }) };
