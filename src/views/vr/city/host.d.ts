import type { ArtifactContent } from "../artifactContent.js";
import type { CityArtifact } from "../cityClient.js";

export const host: {
  el: HTMLElement | null;
  exit: () => void;
  /** Content of an artifact (round 3): fetched through the client with the API's auth. */
  loadArtifact: ((artifact: CityArtifact) => Promise<ArtifactContent>) | null;
  /** Leave VR for the 2D app with this artifact open in its viewer. */
  openIn2D: ((artifact: CityArtifact) => void) | null;
};
