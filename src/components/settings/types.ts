/**
 * Shared shapes for the Settings screen.
 *
 * The settings page is a set of largely independent cards, each owning one
 * slice of configuration. They live in sibling files and share only this
 * module: the serialized settings payload and the small label maps that turn
 * provider category codes into something a person can read.
 */

export interface SettingsDto {
  /**
   * A stored credential exists but could not be decrypted — in practice,
   * AUTH_SECRET changed since it was saved. The individual `…Set` flags below
   * all read false in that case, so this is what tells the difference between
   * "never configured" and "no longer readable".
   */
  secretsUnreadable: boolean;
  watchmodeApiKeySet: boolean;
  watchmodePlan: "paid" | "free" | "unknown" | null;
  seerrUrl: string;
  seerrApiKeySet: boolean;
  countries: string[];
  serviceIds: number[];
  countedTypes: string[];
  tmdbApiKeySet: boolean;
  tmdbRegions: string[];
  tmdbProviderIds: number[];
  tmdbCountedTypes: string[];
  deleteFiles: boolean;
  purgeUnmonitoredFiles: boolean;
  searchAtEnd: boolean;
  removeMissingTmdbMovies: boolean;
  applyChanges: boolean;
  sweepScheduleEnabled: boolean;
  sweepIntervalHours: number;
  sweepIntervalChoices: number[];
  sweepNextRunAt: string | null;
  sweepLastRunAt: string | null;
  sweepSchedulerDisabledByEnv: boolean;
  localLoginEnabled: boolean;
  localLoginEffective: boolean;
  localLoginLock: { locked: boolean; reason: string | null };
  oidcEnabled: boolean;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecretSet: boolean;
  oidcButtonLabel: string;
  oidcButtonLabelDefault: string;
  oidcScopes: string;
  oidcAuthUrl: string;
  oidcTokenUrl: string;
  oidcUserinfoUrl: string;
  oidcAllowedUsers: string[];
  connections: { id: number; type: string; name: string; baseUrl: string; enabled: boolean; origin: string }[];
}

export interface Region {
  code: string;
  name: string;
  flag: string;
}

export interface Service {
  id: number;
  name: string;
  type: string;
  logo: string | null;
}

export interface ServiceGroup {
  country: string;
  services: Service[];
}

/** Props every settings card takes: current values, and a refresh callback. */
export interface CardProps {
  settings: SettingsDto;
  onChange: () => void;
}

/** Watchmode source types. */
export const TYPE_LABELS: Record<string, string> = {
  sub: "Subscription",
  free: "Free",
  purchase: "Purchase",
  rent: "Rent",
  tv_everywhere: "TV Everywhere",
};

// TMDB watch-provider categories.
export const TMDB_TYPE_LABELS: Record<string, string> = {
  flatrate: "Subscription",
  free: "Free",
  ads: "Free with ads",
  rent: "Rent",
  buy: "Buy",
};
