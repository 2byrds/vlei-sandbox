import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestWallet, vLEICredential } from "../test-wallet.ts";
import {
  createTimestamp,
  formatMemberVariables,
  sleep,
} from "../test-utils.ts";

const wallets = Array.from({ length: 3 }).map(
  (_, idx) =>
    new TestWallet({ alias: `member${(idx + 1).toString().padStart(2, "0")}` })
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
          other.identifier.name
        );
      }
    }

    expect((await wallet.client.contacts().list()).length).greaterThanOrEqual(2);
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
  test(
    "Member 2 fails to creates the credential - by misunderstanding",
    async () => {
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
    }
  );

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
    await wallet2.rollback(groupAlias, parseInt(curKe[1].ked.s)+1);

    const keRoll = await wallet2.client.keyEvents().get(group.prefix);
    expect(keRoll).length(2,"Rolledback event should NOT be present");

    const noCreds = await wallet2.client.credentials().list();
    expect(noCreds).length(0,"No credential should be present");
  });

  test("Member 2 needs to catchup with the group issuance", async () => {
    await wallet2.joinCredIssuance(groupAlias);

    const creds = await wallet2.client.credentials().list();
    expect(creds).length(1,"Only one credential should be present");
  });
});
