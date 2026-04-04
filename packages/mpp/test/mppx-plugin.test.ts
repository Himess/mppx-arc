import { describe, it, expect } from "vitest";
import { Method, Challenge, Credential, Receipt } from "mppx";
import { charge, session, Methods } from "../src/methods.js";

describe("mppx Plugin — Method.from() Compliance", () => {
  it("charge method has correct name and intent", () => {
    expect(charge.name).toBe("arc");
    expect(charge.intent).toBe("charge");
  });

  it("session method has correct name and intent", () => {
    expect(session.name).toBe("arc");
    expect(session.intent).toBe("session");
  });

  it("Methods export contains both methods", () => {
    expect(Methods.charge).toBe(charge);
    expect(Methods.session).toBe(session);
  });

  it("charge schema validates correct request", () => {
    const result = charge.schema.request.safeParse({
      amount: "1000000",
      currency: "0x3600000000000000000000000000000000000000",
      recipient: "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
      chainId: "5042002",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chainId).toBe(5042002); // transformed to number
    }
  });

  it("charge schema validates chainId as number", () => {
    const result = charge.schema.request.safeParse({
      amount: "1000000",
      currency: "0x3600000000000000000000000000000000000000",
      recipient: "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
      chainId: 5042002,
    });
    expect(result.success).toBe(true);
  });

  it("charge schema rejects missing fields", () => {
    const result = charge.schema.request.safeParse({
      amount: "1000000",
    });
    expect(result.success).toBe(false);
  });

  it("session schema validates correct request", () => {
    const result = session.schema.request.safeParse({
      payee: "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
      escrow: "0x805aCAD6064CBfABac71a021c3ab432920925533",
      chainId: 5042002,
      currency: "0x3600000000000000000000000000000000000000",
      amountPerRequest: "10000",
      minDeposit: "1000000",
    });
    expect(result.success).toBe(true);
  });

  it("charge credential payload validates push mode", () => {
    const result = charge.schema.credential.payload.safeParse({
      mode: "push",
      txHash: "0xabcdef",
    });
    expect(result.success).toBe(true);
  });

  it("charge credential payload validates pull mode", () => {
    const result = charge.schema.credential.payload.safeParse({
      mode: "pull",
      signature: "0xsig",
      from: "0xaddr",
      nonce: "0xnonce",
      validAfter: "0",
      validBefore: "9999999999",
    });
    expect(result.success).toBe(true);
  });

  it("session credential payload validates voucher action", () => {
    const result = session.schema.credential.payload.safeParse({
      action: "voucher",
      channelId: "0xchannel",
      cumulativeAmount: "50000",
      nonce: "3",
      signature: "0xsig",
    });
    expect(result.success).toBe(true);
  });

  it("session credential payload validates open action", () => {
    const result = session.schema.credential.payload.safeParse({
      action: "open",
      channelId: "0xchannel",
      txHash: "0xtx",
    });
    expect(result.success).toBe(true);
  });

  it("session credential payload rejects invalid action", () => {
    const result = session.schema.credential.payload.safeParse({
      action: "invalid",
      channelId: "0x123",
    });
    expect(result.success).toBe(false);
  });
});

describe("mppx Plugin — Challenge Serialization", () => {
  it("can create and serialize a charge challenge", () => {
    const challenge = Challenge.from({
      id: "test-challenge-1",
      realm: "api.example.com",
      method: "arc",
      intent: "charge",
      request: {
        amount: "1000000",
        currency: "0x3600000000000000000000000000000000000000",
        recipient: "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
        chainId: "5042002",
      },
    });

    const serialized = Challenge.serialize(challenge);
    expect(serialized).toContain("Payment");
    expect(serialized).toContain("arc");
    expect(serialized).toContain("charge");

    const deserialized = Challenge.deserialize(serialized);
    expect(deserialized.method).toBe("arc");
    expect(deserialized.intent).toBe("charge");
    expect(deserialized.request.amount).toBe("1000000");
  });

  it("can create and serialize a session challenge", () => {
    const challenge = Challenge.from({
      id: "test-challenge-2",
      realm: "api.example.com",
      method: "arc",
      intent: "session",
      request: {
        payee: "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
        escrow: "0x805aCAD6064CBfABac71a021c3ab432920925533",
        chainId: "5042002",
        currency: "0x3600000000000000000000000000000000000000",
        amountPerRequest: "10000",
        minDeposit: "1000000",
      },
    });

    const serialized = Challenge.serialize(challenge);
    const deserialized = Challenge.deserialize(serialized);
    expect(deserialized.method).toBe("arc");
    expect(deserialized.intent).toBe("session");
  });
});

describe("mppx Plugin — Credential Serialization", () => {
  it("can create and serialize a charge credential", () => {
    const challenge = Challenge.from({
      id: "cred-test-1",
      realm: "api.example.com",
      method: "arc",
      intent: "charge",
      request: {
        amount: "1000000",
        currency: "0x360",
        recipient: "0xabc",
        chainId: "5042002",
      },
    });

    const credential = Credential.from({
      challenge,
      payload: {
        mode: "push",
        txHash: "0xdeadbeef",
      },
    });

    const serialized = Credential.serialize(credential);
    expect(serialized).toContain("Payment ");

    const deserialized = Credential.deserialize(serialized);
    expect(deserialized.payload.mode).toBe("push");
    expect(deserialized.payload.txHash).toBe("0xdeadbeef");
    expect(deserialized.challenge.method).toBe("arc");
  });
});

describe("mppx Plugin — Receipt", () => {
  it("can create a valid receipt", () => {
    const receipt = Receipt.from({
      method: "arc",
      status: "success",
      timestamp: new Date().toISOString(),
      reference: "0xtxhash",
    });

    expect(receipt.method).toBe("arc");
    expect(receipt.status).toBe("success");
    expect(receipt.reference).toBe("0xtxhash");
  });

  it("can serialize and deserialize receipt", () => {
    const receipt = Receipt.from({
      method: "arc",
      status: "success",
      timestamp: new Date().toISOString(),
      reference: "0xabc123",
    });

    const serialized = Receipt.serialize(receipt);
    const deserialized = Receipt.deserialize(serialized);

    expect(deserialized.method).toBe("arc");
    expect(deserialized.reference).toBe("0xabc123");
  });
});
