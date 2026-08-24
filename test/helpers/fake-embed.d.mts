export declare function installFakeEmbed(options?: {
  dimension?: number;
}): Promise<() => Promise<void> | void>;

export declare function restoreFakeEmbed(): Promise<void> | void;
