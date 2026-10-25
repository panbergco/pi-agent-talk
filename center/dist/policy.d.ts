import type { Priority } from "./store.js";
export interface Rule {
    from: string;
    to: string;
    max?: Priority;
    reason?: string;
}
export interface ProjectPolicy {
    closed?: boolean;
    closedReason?: string;
    projectIsRole?: boolean;
    /** "human-turn": an agent may send only within a turn its human started (the binding attests it). */
    agentSend?: "always" | "human-turn";
    agentSendReason?: string;
    agentSendExempt?: string[];
    allow?: Rule[];
    deny?: Rule[];
    broadcast?: string[];
    quiet?: string[];
}
export interface Party {
    address: string;
    role: string | null;
    project: string | null;
}
export type Verdict = {
    ok: true;
    cap?: Priority;
    grant?: Priority;
    note?: string;
    human?: true;
} | {
    ok: false;
    reason: string;
};
export declare class Policy {
    private readonly path;
    private file;
    private stamp;
    private text;
    private checkedAt;
    constructor(path: string | null);
    private load;
    limits(): {
        perMinute: number;
        pairPer10Min: number;
    };
    forProject(project: string | null): ProjectPolicy | undefined;
    /** May `from` send to `to` at `priority`? `fanout` = role or project targeting. */
    check(from: Party, to: Party, priority: Priority, fanout: "direct" | "role" | "project", humanTurn?: boolean, autonomous?: boolean): Verdict;
}
export declare const lower: (a: Priority, cap?: Priority) => Priority;
export declare const within: (a: Priority, max?: Priority) => boolean;
