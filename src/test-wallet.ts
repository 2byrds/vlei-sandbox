import {
  Algos,
  d,
  HabState,
  messagize,
  Operation,
  randomPasscode,
  ready,
  Siger,
  SignifyClient,
  Tier,
  randomNonce,
  CreateRegistryArgs,
  CredentialData,
  Saider,
  State,
  IssueCredentialArgs,
} from "signify-ts";
// } from "signify-ts-old"; // Use signify-ts-old if testing against KERIA 0.1.3
import { sleep } from "./test-utils";
import { json } from "stream/consumers";

export const KERIA_HOSTNAME = process.env.KERIA_HOSTNAME ?? `localhost`;
export const KERIA_AGENT_URL = `http://${KERIA_HOSTNAME}:3901`;
export const KERIA_PORT = 3901;
export const KERIA_BOOT_URL = `http://${KERIA_HOSTNAME}:3903`;

export const KERIA_DEBUG_HOSTNAME = process.env.KERIA_HOSTNAME ?? `localhost`;
export const KERIA_DEBUG_AGENT_URL = `http://${KERIA_DEBUG_HOSTNAME}:4901`;
export const KERIA_DEBUG_PORT = 4901;
export const KERIA_DEBUG_BOOT_URL = `http://${KERIA_DEBUG_HOSTNAME}:4903`;

export interface TestWalletOptions {
  alias: string;
  passcode?: string;
  debug?: boolean;
}

function assertDefined<T>(obj: T | null): asserts obj is T {
  if (!obj) {
    throw new Error("Unexpected null value");
  }
}

export class TestWallet {
  static randomNonce(): string {
    return randomNonce();
  }

  private _client: SignifyClient | null = null;
  private _identifier: HabState | null = null;

  constructor(public options: TestWalletOptions) {}

  get identifier(): HabState {
    assertDefined(this._identifier);
    return this._identifier;
  }

  get client(): SignifyClient {
    assertDefined(this._client);
    return this._client;
  }

  async refreshIdentifier() {
    try {
      const result = await this.client.identifiers().get(this.options.alias);
      this._identifier = result;
    } catch (error) {
      //ignore
    }
  }

  async init() {
    await this.boot(this.options.debug);
    await this.connect();
    await this.createIdentifier();
  }

  async boot(debug=false) {
    await ready();
    const kurl = debug ? KERIA_DEBUG_AGENT_URL : KERIA_AGENT_URL;
    const kburl = debug ? KERIA_DEBUG_BOOT_URL : KERIA_BOOT_URL;

    if (!this.options.passcode) {
      const passcode = randomPasscode();
      const client = new SignifyClient(
        kurl,
        passcode,
        Tier.low,
        kburl
      );
      await client.boot();
      this._client = client;
    } else {
      const client = new SignifyClient(
        kurl,
        this.options.passcode,
        Tier.low
      );
      this._client = client;
    }
  }

  async connect() {
    await this.client.connect();
  }

  async listAgents() {
    const path = `/identifiers/${this.options.alias}/endroles/agent`;
    const response: Response = await this.client.fetch(path, "GET", null);
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const result = await response.json();
    return result;
  }

  async createIdentifier() {
    await this.refreshIdentifier();
    if (this._identifier) {
      return;
    }

    const agentId = this.client.agent?.pre;
    if (!agentId) {
      throw new Error(`No agent id available`);
    }

    const alias = this.options.alias;

    const inceptResult = await this.client.identifiers().create(alias, {
      transferable: true,
    });
    const inceptOperation = await inceptResult.op();
    await this.wait(inceptOperation);

    const agentResult = await this.client
      .identifiers()
      .addEndRole(alias, "agent", agentId);
    const agentOperation = await agentResult.op();
    await this.wait(agentOperation);

    await this.refreshIdentifier();
  }

  async queryExchanges(filter: unknown) {
    const path = `/exchanges/query`;
    const res = await this.client.fetch(path, "POST", { filter });
    return res.json();
  }

  async generateOobi(alias?: string): Promise<string> {
    const result = await this.client
      .oobis()
      .get(alias ?? this.options.alias, "agent");

    const oobi = result.oobis[0];

    if (!oobi || typeof oobi !== "string") {
      throw new Error("No oobi generated");
    }

    return oobi;
  }

  async resolveOobi(oobi: string, alias?: string, debug?: boolean) {
    // if the client is a docker client (3901), but the oobi is a debug oobi (4902) then substitute localhost with host.docker.internal
    if (debug && this.client.url.match(/3901/) && oobi.match(/4902/)) {
      oobi = oobi.replace(/localhost/g, 'host.docker.internal');
    }
    const op2 = await this.client.oobis().resolve(oobi, alias);
    await this.wait(op2);
  }

  async queryKeyState(
    prefix: string,
    options: { sn?: string; signal?: AbortSignal } = {}
  ) {
    const op = await this.client.keyStates().query(prefix, options.sn);
    await this.wait(op, { signal: options.signal });
  }

  async createGroup(
    groupAlias: string,
    args: {
      smids: string[];
      isith: number;
      nsith?: number;
      wits: string[];
      toad: number;
    }
  ) {
    const mhab = this.identifier;
    if (!mhab) {
      throw new Error("No local identifier created");
    }

    const states = await Promise.all(
      args.smids.map(async (member) => {
        const result = await this.client.keyStates().get(member);
        return result[0];
      })
    );

    const res = await this.client.identifiers().create(groupAlias, {
      algo: Algos.group,
      isith: args.isith,
      nsith: args.nsith ?? args.isith,
      mhab,
      states,
      rstates: states,
      wits: args.wits,
      toad: args.toad,
    });

    const attachment = d(
      messagize(
        res.serder,
        res.sigs.map((sig: string) => new Siger({ qb64: sig }))
      )
    ).substring(res.serder.size);

    const embeds = {
      icp: [res.serder, attachment],
    };

    await this.client
      .exchanges()
      .send(
        mhab.name,
        "multisig",
        mhab,
        "/multisig/icp",
        { smids: args.smids },
        embeds,
        args.smids
      );

    return await res.op();
  }

  private createSeal(hab: HabState) {
    const habStateEvent = hab.state?.ee as { s: string; d: string };
    const seal = [
      "SealEvent",
      {
        i: hab["prefix"],
        s: habStateEvent["s"],
        d: habStateEvent["d"],
      },
    ];

    return seal;
  }

  async listEndRoles(alias: string, role = "agent") {
    const path =
      role !== undefined
        ? `/identifiers/${alias}/endroles/${role}`
        : `/identifiers/${alias}/endroles`;
    const response: Response = await this.client.fetch(path, "GET", null);
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    return result;
  }

  async configureGroupAgents(
    groupAlias: string,
    dt: string
  ): Promise<Operation[]> {
    const members = await this.client.identifiers().members(groupAlias);
    const ops: Operation[] = [];

    for (const { aid, ends } of members.signing) {
      const [agentId] = Object.keys(ends.agent);

      if (typeof agentId !== "string") {
        throw new Error(`No agent id on member ${aid}`);
      }

      const op = await this.addEndRole(groupAlias, dt, agentId);
      ops.push(op);
    }

    return ops;
  }

  async listOtherMembers(group: HabState): Promise<string[]> {
    const recipients = await this.client
      .identifiers()
      .members(group.name)
      .then((members) =>
        members.signing
          .map((m: { aid: string }) => m.aid)
          .filter((aid: string) => aid !== group.group?.mhab.prefix)
      );

    return recipients;
  }

  async addEndRole(groupAlias: string, timestamp: string, agentId: string) {
    const hab = await this.client.identifiers().get(groupAlias);
    const result = await this.client
      .identifiers()
      .addEndRole(hab.name, "agent", agentId, timestamp);
    const operation = await result.op();

    if ("group" in hab && hab.group) {
      const recipients = await this.listOtherMembers(hab);
      const seal = this.createSeal(hab);
      const sigers = result.sigs.map((sig: string) => new Siger({ qb64: sig }));
      const roleims = d(
        messagize(result.serder, sigers, seal, undefined, undefined, false)
      );
      const atc = roleims.substring(result.serder.size);

      await this.client.exchanges().send(
        hab.group.mhab.name,
        "multisig",
        hab.group.mhab,
        "/multisig/rpy",
        { gid: hab.prefix },
        {
          rpy: [result.serder, atc],
        },
        recipients
      );
    }

    return operation;
  }

  async refreshState(groupAlias: string, anchor?: string) {
    let hab = await this.client.identifiers().get(groupAlias);
    const op = await this.client
      .keyStates()
      .query(hab.prefix, undefined, anchor);
    return op;
  }

  async createRegistry(args: CreateRegistryArgs) {
    let hab = await this.client.identifiers().get(args.name);

    const result = await this.client.registries().create({
      name: args.name,
      registryName: args.registryName,
      nonce: args.nonce,
    });

    const op = await result.op();

    if ("group" in hab && hab.group) {
      const recipients = await this.listOtherMembers(hab);
      const sigers = result.sigs.map((sig: string) => new Siger({ qb64: sig }));
      const ims = d(messagize(result.serder, sigers));
      const atc = ims.substring(result.serder.size);

      await this.client.exchanges().send(
        hab.group.mhab.name,
        "multisig",
        hab.group.mhab,
        "/multisig/vcp",
        { gid: hab.prefix },
        {
          vcp: [result.regser, ""],
          anc: [result.serder, atc],
        },
        recipients
      );
    }

    return op;
  }

  async createCredential(groupAlias: string, args: IssueCredentialArgs) {
    let hab = await this.client.identifiers().get(groupAlias);

    const result = await this.client.credentials().issue(groupAlias, args);
    const op = result.op;

    if ("group" in hab && hab.group) {
      const recipients = await this.listOtherMembers(hab);
      const keeper = this.client.manager?.get(hab);
      const sigs =
        (await keeper?.sign(new TextEncoder().encode(result.anc.raw))) ?? [];
      const sigers = sigs.map((sig: string) => new Siger({ qb64: sig }));
      const ims = d(messagize(result.anc, sigers));
      const atc = ims.substring(result.anc.size);

      await this.client.exchanges().send(
        hab.group.mhab.name,
        "multisig",
        hab.group.mhab,
        "/multisig/iss",
        { gid: hab.prefix },
        {
          acdc: [result.acdc, ""],
          iss: [result.iss, ""],
          anc: [result.anc, atc],
        },
        recipients
      );
    }

    return op;
  }

  async clearNotifications() {
    let { notes } = await this.client.notifications().list();
    while (notes.length > 0) {
      await Promise.all(
        notes.map((note: { i: string }) =>
          this.client.notifications().delete(note.i)
        )
      );

      const response = await this.client.notifications().list();
      notes = response.notes;
    }
  }

  async join(group: string, exn: any): Promise<Operation> {
    switch (exn.exn.r) {
      case "/multisig/iss":
        return await this.createCredential(group, exn.exn.e);
      case "/ipex/grant":
      case "/multisig/rpy":
      case "/multisig/vcp":
      case "/multisig/exn":
      case "/multisig/icp":
      default:
        throw new Error(`Do not know how to join ${exn.exn.r} at the moment`);
    }
  }

  async joinCredIssuance(group: string): Promise<void> {
      const note = await this.waitNotification("/multisig/iss", AbortSignal.timeout(100000));
      const exn = await this.client.exchanges().get(note.a.d);
      const op = await this.join(group, exn);
    
      await this.wait(op, { signal: AbortSignal.timeout(200000) });
        
  }

  async waitNotification(route: string, signal: AbortSignal) {
    while (!signal.aborted) {
      const response = await this.client.notifications().list();
      const note = response.notes
        .reverse()
        .find((note: { a: { r: string } }) => note.a.r === route);

      if (note) {
        return note;
      }
    }

    signal.throwIfAborted();
  }

  /**
   * Mark and remove notification.
   */
  async markAndRemoveNotification(
    note: Notification
  ): Promise<void> {
    try {
        await this.client.notifications().mark(note.i);
    } finally {
        await this.client.notifications().delete(note.i);
    }
  }

  async queryLastKeyState(prefix: string, sn?: number): Promise<State> {
    const { oobi, alias } = await this.client.contacts().get(prefix);
    await this.resolveOobi(oobi, alias);
    const operation = await this.client
      .keyStates()
      .query(prefix, sn ? `${sn}` : undefined);
    const result = await this.wait<State>(operation);
    if (!result.response) {
      throw new Error("no response from queryLastKeyState");
    }
    return result.response;
  }

  async rotateIdentifier(props: RotateIdentifierProps) {
    if (!this._identifier) {
      throw new Error("identifier not set");
    }

    await this.refreshIdentifier();

    const localIdentifier = this._identifier;

    const { identifierAlias, rotationStates } = props;

    const identifierToRotate = await this.client
      .identifiers()
      .get(identifierAlias);

    if (!identifierToRotate.group) {
      const result = await this.client.identifiers().rotate(identifierAlias);
      return result.op();
    }

    if (!rotationStates) {
      throw new Error("must provide rotationStates for group identifier");
    }

    const members = await this.getGroupMembers({ alias: identifierAlias });
    const membersAfterRotation = members.rotation.map(({ aid }) => aid);

    const signingStates = await Promise.all(
      membersAfterRotation.map(async (prefix) => {
        if (prefix === localIdentifier.prefix) {
          return localIdentifier.state;
        }
        return this.queryLastKeyState(prefix);
      })
    );
    const rotationStatesQueried = await Promise.all(
      rotationStates.map(async (state) => {
        if (state.i === localIdentifier.prefix) {
          return localIdentifier.state;
        }
        return this.queryLastKeyState(state.i);
      })
    );

    const result = await this.client.identifiers().rotate(identifierAlias, {
      states: signingStates,
      rstates: rotationStatesQueried,
    });

    const operation = await result.op();

    const attachment = d(
      messagize(
        result.serder,
        result.sigs.map((sig: string) => new Siger({ qb64: sig }))
      )
    ).substring(result.serder.size);

    const smids = signingStates.map((states) => states.i);
    const rmids = rotationStatesQueried.map((states) => states.i);

    const recipients = [...smids, ...rmids]
      .filter((aid) => aid !== localIdentifier.prefix)
      .filter((aid, i, states) => states.indexOf(aid) === i);

    await this.client.exchanges().send(
      identifierToRotate.group.mhab.name,
      "multisig",
      identifierToRotate.group.mhab,
      "/multisig/rot",
      { gid: result.serder.pre, smids, rmids },
      {
        rot: [result.serder, attachment],
      },
      recipients ?? []
    );

    return operation;
  }

  async getGroupMembers(args: { alias: string }): Promise<GroupMembers> {
    const response = await this.client.fetch(
      `/identifiers/${args.alias}/members`,
      "GET",
      null
    );
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${
          response.statusText
        } - ${await response.text()}`
      );
    }
    const groupMembers = await response.json();
    if (!groupMembers) {
      return { rotation: [], signing: [] };
    }

    return groupMembers as any;
  }

  async rollback<T>(name: string, sn: number): Promise<void> {
    const path = `/identifiers/${name}/events`;
    const data = {'sn_rollback': sn,};
    const method = 'POST';
    const res = await this.client.fetch(path, method, data);    
  }

  async deleteEscrows<T>(name: string, escrow: string): Promise<void> {
    const path = `/escrows/clear/${name}/${escrow}`;
    const method = 'DELETE';
    const res = await this.client.fetch(path, method, null);    
  }

  async wait<T>(
    op: Operation<T>,
    options: {
      signal?: AbortSignal;
      minSleep?: number;
      maxSleep?: number;
      increaseFactor?: number;
      onRetry?: (op: Operation) => void;
    } = {}
  ): Promise<Operation<T>> {
    let operation = op;
    let retryCount = 0;
    if (op.metadata?.depends) {
      await this.wait<unknown>(op.metadata.depends, options);
    }

    while (!operation.done) {
      options.signal?.throwIfAborted();

      operation = await this.client.operations().get(operation.name);

      if (options.onRetry) {
        options.onRetry(operation);
      }

      await sleep(
        Math.min(
          Math.max(
            options.minSleep ?? 100,
            (options.increaseFactor ?? 2) ** retryCount
          ),
          options.maxSleep ?? 1000
        )
      );

      retryCount++;
    }
    return operation;
  }

  async getRegistry(args: {
    owner: string;
    name: string;
  }): Promise<{ regk: string }> {
    const path = `/identifiers/${args.owner}/registries/${args.name}`;
    const method = "GET";
    const res = await this.client.fetch(path, method, null);
    return (await res.json()) as any;
  }
}

export interface RotateIdentifierProps {
  identifierAlias: string;
  rotationStates?: State[];
}

export interface GroupMember {
  aid: string;
  ends: Record<string, unknown>;
}

export interface GroupMembers {
  signing: GroupMember[];
  rotation: GroupMember[];
}

export interface CredentialConfig {
  registry: string;
  holder: string;
  issuer: string;
  timestamp: string;
  LEI: string;
}

export interface QviCredentialConfig extends CredentialConfig {}
export interface LegalEntityCredentialConfig extends CredentialConfig {
  qviCredential: string;
}

export class vLEICredential {
  static qvi(args: QviCredentialConfig): IssueCredentialArgs {
    return {acdc:{
      ri: args.registry,
      s: "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao",
      a: {
        dt: args.timestamp,
        i: args.holder,
        LEI: args.LEI,
      },
      r: Saider.saidify({
        d: "",
        usageDisclaimer: {
          l: "Usage of a valid, unexpired, and non-revoked vLEI Credential, as defined in the associated Ecosystem Governance Framework, does not assert that the Legal Entity is trustworthy, honest, reputable in its business dealings, safe to do business with, or compliant with any laws or that an implied or expressly intended purpose will be fulfilled.",
        },
        issuanceDisclaimer: {
          l: "All information in a valid, unexpired, and non-revoked vLEI Credential, as defined in the associated Ecosystem Governance Framework, is accurate as of the date the validation process was complete. The vLEI Credential has been issued to the legal entity or person named in the vLEI Credential as the subject; and the qualified vLEI Issuer exercised reasonable care to perform the validation process set forth in the vLEI Ecosystem Governance Framework.",
        },
      })[1],
    }
  }}
}

export interface Notification {
  i: string;
  dt: string;
  r: boolean;
  a: { r: string; d?: string; m?: string };
}