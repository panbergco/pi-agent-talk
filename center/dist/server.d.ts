/**
 * MACP 2.0 reference center — per-session MCP server (spec §6).
 * Tools: macp_register / macp_send / macp_ack / macp_roster / macp_grant.
 * Resources: macp://self · macp://project/{project}/roster · macp://agent/{address}/inbox.
 * All standard MCP: no custom methods, no custom notification types.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Store } from "./store.js";
import { Policy } from "./policy.js";
export interface SessionCtx {
    sessionId: string;
    address: string | null;
    project: string | null;
    isOperator: boolean;
    roots: string[];
    subscriptions: Set<string>;
    server: McpServer;
}
/** Cross-session router: address → live session, for inbox update notifications. */
export declare class Notifier {
    private byAddress;
    bind(ctx: SessionCtx): void;
    unbind(ctx: SessionCtx): void;
    /** The live connection currently holding an identity, if any. */
    holder(address: string): SessionCtx | undefined;
    /** Notify the recipient's session that its inbox resource changed (spec §6.2/§6.3 rung 1). */
    notifyInbox(address: string): Promise<void>;
}
export declare function buildSessionServer(store: Store, notifier: Notifier, opts: {
    operatorToken: string | null;
    policy?: Policy;
    strict?: boolean;
}): SessionCtx;
