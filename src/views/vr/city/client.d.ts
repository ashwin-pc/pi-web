import type { CityClient } from "../cityClient.js";
export let client: CityClient | null;
export function installClient(value: CityClient): void;
