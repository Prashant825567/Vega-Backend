/**
 * The shapes the providers answer with.
 *
 * Copied from the app's `src/lib/providers/types.ts` and cut down to what these
 * five providers actually use: the app's copy also describes providers that talk
 * to a WebView and a device crypto module, neither of which exists on a server.
 * The fields that remain are the ones the app's screens read, so JSON this
 * backend returns drops straight into the app's own components.
 */

export interface Post {
  title: string;
  link: string;
  image: string;
  provider?: string;
}

export type TextTracks = {
  title: string;
  language: string;
  type: string;
  uri: string;
}[];

/** One playable stream, as the app's Player expects it. */
export interface Stream {
  server: string;
  link: string;
  type: string;
  quality?: '360' | '480' | '720' | '1080' | '2160';
  subtitles?: TextTracks;
  headers?: Record<string, string>;
  size?: number;
}

/** Everything a details screen needs. */
export interface Info {
  title: string;
  image: string;
  synopsis: string;
  imdbId: string;
  type: string;
  webUrl?: string;
  tags?: string[];
  cast?: string[];
  rating?: string;
  year?: string;
  linkList: Link[];
}

export interface EpisodeLink {
  id?: string;
  title: string;
  link: string;
  sourceLink?: string;
}

export interface Link {
  title: string;
  quality?: string;
  episodesLink?: string;
  directLinks?: {
    title: string;
    link: string;
    type?: 'movie' | 'series';
  }[];
}
