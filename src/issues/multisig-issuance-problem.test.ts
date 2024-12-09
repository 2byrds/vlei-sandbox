import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestWallet, vLEICredential } from "../test-wallet.ts";
import {
  createTimestamp,
  formatMemberVariables,
  sleep,
} from "../test-utils.ts";
import { IssueCredentialArgs, Serder } from "signify-ts";

// Which wallet (zero indexed) is being debugged on keria 4902
const dwal = -1;

const wallets = Array.from({ length: 3 }).map(
  (_, idx) =>
    new TestWallet({
      alias: `member${(idx + 1).toString().padStart(2, "0")}`,
      debug: idx === dwal,
    })
);

const [wallet1, wallet2, wallet3] = wallets;
const isith = wallets.length - 1;

const groupAlias = "group";
const registryName = "reg";
let registryNonce: string;
let regk: string;
let wits: string[];
let toad: number;

beforeAll(async () => {
  await Promise.all(wallets.map((w) => w.init()));
  registryNonce = TestWallet.randomNonce();
  wits = process.env.WITNESS_IDS?.split(";") ?? [];
  toad = Math.min(wits.length, Math.max(wits.length - 1, 0));
});

afterAll(async () => {
  formatMemberVariables(wallets);
});

test("Resolve OOBIs", async () => {
  for (const wallet of wallets) {
    for (const other of wallets) {
      if (other.identifier.prefix !== wallet.identifier.prefix) {
        await wallet.resolveOobi(
          await other.generateOobi(),
          other.identifier.name,
          other.options.debug
        );
      }
    }

    expect((await wallet.client.contacts().list()).length).greaterThanOrEqual(
      2
    );
  }
});

test("All members create multisig group", async () => {
  const smids = wallets.map((w) => w.identifier.prefix);

  await Promise.all(
    wallets.map(async (wallet) => {
      const op = await wallet.createGroup(groupAlias, {
        smids,
        isith,
        wits,
        toad,
      });
      await wallet.wait(op);
    })
  );
});

test("All members create registry", async () => {
  await Promise.all(
    wallets.map(async (wallet) => {
      const op = await wallet.createRegistry({
        name: groupAlias,
        registryName,
        nonce: registryNonce,
      });
      await wallet.wait(op);
    })
  );

  const [registry] = await wallet1.client.registries().list(groupAlias);
  expect(registry).toHaveProperty("regk");
});

describe("Credential issuance", async () => {
  const LEI = "OO123123123123123123";

  test.concurrent("Member 1 creates the credential", async () => {
    const group = await wallet1.client.identifiers().get(groupAlias);
    const registry = await wallet1.getRegistry({
      owner: groupAlias,
      name: registryName,
    });

    const op = await wallet1.createCredential(
      groupAlias,
      vLEICredential.qvi({
        holder: wallet1.identifier.prefix,
        issuer: group.prefix,
        LEI,
        registry: registry.regk,
        timestamp: createTimestamp(),
      })
    );

    await wallet1.wait(op, { signal: AbortSignal.timeout(20000) });
  });

  test.concurrent("Member 3 joins credential issuance event", async () => {
    wallet3.joinCredIssuance(groupAlias);
  });

  let credOp2;
  test("Member 2 fails to creates the credential - by misunderstanding", async () => {
    // Member 2 accidentally creates the credential on their own, perhaps a misunderstanding
    const group = await wallet2.client.identifiers().get(groupAlias);
    const keGroup = await wallet2.client.keyEvents().get(group.prefix);
    const registry = await wallet2.getRegistry({
      owner: groupAlias,
      name: registryName,
    });
    const keRegistry = await wallet2.client.keyEvents().get(group.prefix);
    credOp2 = await wallet2.createCredential(
      groupAlias,
      vLEICredential.qvi({
        holder: wallet1.identifier.prefix,
        issuer: group.prefix,
        LEI,
        registry: registry.regk,
        timestamp: createTimestamp(),
      })
    );

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 20000);

    try {
      const keCred = await wallet2.client.keyEvents().get(group.prefix);
      const wop = await wallet2.wait(credOp2, {
        signal: AbortSignal.timeout(3000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("Operation was aborted");
      } else {
        console.error("Oops! User 2 realizes their mistake");
      }
    } finally {
      clearTimeout(timeoutId);
    }
  });

  // test("Resolve OOBIs", async () => {
  //   for (const other of wallets) {
  //     if (other.identifier.prefix !== wallet2.identifier.prefix) {
  //       await wallet2.resolveOobi(
  //         await other.generateOobi(),
  //         other.identifier.name
  //       );
  //     }
  //   }

  //   expect(await wallet2.client.contacts().list()).toHaveLength(2);
  // });

  test("Member 2 rollsback the credential issuance event", async () => {
    const group = await wallet2.client.identifiers().get(groupAlias);

    await wallet2.client.operations().delete(credOp2!.name);
    const curKe = await wallet2.client.keyEvents().get(group.prefix);
    await wallet2.rollback(groupAlias, parseInt(curKe[1].ked.s) + 1);

    const keRoll = await wallet2.client.keyEvents().get(group.prefix);
    expect(keRoll).length(2, "Rolledback event should NOT be present");

    await wallet2.deleteEscrows(groupAlias, "all");
    await wallet3.deleteEscrows(groupAlias, "all");
    await wallet1.deleteEscrows(groupAlias, "all");

    // const newCurKe = await wallet2.client.keyEvents().get(group.prefix);
    // await wallet2.rollback(groupAlias, parseInt(newCurKe[1].ked.s));

    const noCreds = await wallet2.client.credentials().list();
    expect(noCreds).length(0, "No credentials should be present");

    // for (const other of wallets) {
    //   if (other.identifier.prefix !== wallet2.identifier.prefix) {
    //     await wallet2.resolveOobi(
    //       await other.generateOobi(),
    //       groupAlias
    //     );
    //   }
    // }
  });

  let qviCred: IssueCredentialArgs;
  test("verifier IPEX apply", async () => {
    const group = await wallet1.client.identifiers().get(groupAlias);
    const registry = await wallet1.getRegistry({
      owner: groupAlias,
      name: registryName,
    });
    qviCred = vLEICredential.qvi({
      holder: wallet1.identifier.prefix,
      issuer: group.prefix,
      LEI,
      registry: registry.regk,
      timestamp: createTimestamp(),
    });
    const [apply, sigs, _] = await wallet2.client.ipex().apply({
      senderName: wallet2.identifier.name,
      schemaSaid: qviCred.acdc.s!,
      attributes: { LEI: LEI },
      recipient: wallet1.identifier.prefix,
      datetime: createTimestamp(),
    });

    const op = await wallet2.client
      .ipex()
      .submitApply(wallet2.identifier.name, apply, sigs, [
        wallet1.identifier.prefix,
      ]);
    await wallet2.wait(op);
  });

  let applySaid: string;
  test("holder IPEX apply receive and offer", async () => {
    const holderNotifications = await wallet1.waitNotification(
      "/exn/ipex/apply",
      AbortSignal.timeout(100000)
    );

    expect(holderNotifications.a.d);

    const apply = await wallet1.client.exchanges().get(holderNotifications.a.d);
    applySaid = apply.exn.d;

    let filter: { [x: string]: any } = { "-s": apply.exn.a.s };
    for (const key in apply.exn.a.a) {
      filter[`-a-${key}`] = apply.exn.a.a[key];
    }

    const matchingCreds = await wallet1.client.credentials().list({ filter });
    expect(matchingCreds).toHaveLength(1);

    await wallet1.markAndRemoveNotification(holderNotifications);

    const [offer, sigs, end] = await wallet1.client.ipex().offer({
      senderName: wallet1.identifier.name,
      recipient: wallet2.identifier.prefix,
      acdc: new Serder(matchingCreds[0].sad),
      applySaid: applySaid,
      datetime: createTimestamp(),
    });

    const op = await wallet1.client
      .ipex()
      .submitOffer(wallet1.identifier.name, offer, sigs, end, [
        wallet2.identifier.prefix,
      ]);
    await wallet1.wait(op);
  });

  let offerSaid: string;
  test("verifier receive offer and agree", async () => {
    const verifierNotifications = await wallet2.waitNotification(
      "/exn/ipex/offer",
      AbortSignal.timeout(100000)
    );

    expect(verifierNotifications.a.d);

    const offer = await wallet2.client
      .exchanges()
      .get(verifierNotifications.a.d);
    offerSaid = offer.exn.d;

    expect(offer.exn.p).toBe(applySaid);
    expect(offer.exn.e.acdc.a.LEI).toBe(LEI);

    await wallet2.markAndRemoveNotification(verifierNotifications);

    const [agree, sigs, _] = await wallet2.client.ipex().agree({
      senderName: wallet2.identifier.name,
      recipient: wallet1.identifier.prefix,
      offerSaid: offerSaid,
      datetime: createTimestamp(),
    });

    const op = await wallet2.client
      .ipex()
      .submitAgree(wallet2.identifier.name, agree, sigs, [
        wallet1.identifier.prefix,
      ]);
    await wallet2.wait(op);
  });

  let agreeSaid: string;
  test("holder IPEX receive agree and grant/present", async () => {
    const holderNotifications = await wallet1.waitNotification(
      "/exn/ipex/agree",
      AbortSignal.timeout(100000)
    );

    expect(holderNotifications.a.d);

    const agree = await wallet1.client.exchanges().get(holderNotifications.a.d);
    agreeSaid = agree.exn.d;

    expect(agree.exn.p).toBe(offerSaid);

    await wallet1.markAndRemoveNotification(holderNotifications);

    const holderCredentials = await wallet1.client.credentials().list();
    const holderCredential = holderCredentials[0];

    const [grant2, gsigs2, gend2] = await wallet1.client.ipex().grant({
      senderName: wallet1.identifier.name,
      recipient: wallet2.identifier.prefix,
      acdc: new Serder(holderCredential.sad),
      anc: new Serder(holderCredential.anc),
      iss: new Serder(holderCredential.iss),
      acdcAttachment: holderCredential.atc,
      ancAttachment: holderCredential.ancatc,
      issAttachment: holderCredential.issAtc,
      agreeSaid: agreeSaid,
      datetime: createTimestamp(),
    });

    const op = await wallet1.client
      .ipex()
      .submitGrant(wallet1.identifier.name, grant2, gsigs2, gend2, [
        wallet2.identifier.prefix,
      ]);
    await wallet1.wait(op);
  });

  test("verifier receives IPEX grant", async () => {
    const group = await wallet1.client.identifiers().get(groupAlias);
    const verifierNotifications = await wallet2.waitNotification(
      "/exn/ipex/grant",
      AbortSignal.timeout(100000)
    );

    expect(verifierNotifications.a.d);

    const grant = await wallet1.client
      .exchanges()
      .get(verifierNotifications.a.d);
    expect(grant.exn.p).toBe(agreeSaid);

    const [admit3, sigs3, aend3] = await wallet2.client.ipex().admit({
      senderName: wallet2.identifier.name,
      message: "",
      grantSaid: verifierNotifications.a.d!,
      recipient: wallet1.identifier.prefix,
      datetime: createTimestamp(),
    });

    const op = await wallet2.client
      .ipex()
      .submitAdmit(wallet2.identifier.name, admit3, sigs3, aend3, [
        wallet1.identifier.prefix,
      ]);
    await wallet2.wait(op);

    await wallet2.markAndRemoveNotification(verifierNotifications);

    const verifierCredentials = await wallet1.client.credentials().list();
    const verifierCredential = verifierCredentials[0];

    expect(verifierCredential.sad.s).eq(qviCred.acdc.s!);
    expect(verifierCredential.sad.i).eq(group.prefix);
    expect(verifierCredential.status.s).eq("0"); // 0 = issued
  });

  test("holder IPEX present response", async () => {
    const holderNotifications = await wallet1.waitNotification(
      "/exn/ipex/admit",
      AbortSignal.timeout(100000)
    );

    await wallet1.markAndRemoveNotification(holderNotifications);
  });

  test("Member 2 needs to catchup with the group issuance", async () => {
    await wallet2.joinCredIssuance(groupAlias);

    const creds = await wallet2.client.credentials().list();
    expect(creds).length(1, "Only one credential should be present");
  });
});
