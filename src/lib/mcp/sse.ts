import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import contentType from "content-type";
import { Encoding, EventHandlerRequest, EventStream, H3Event } from "h3";
import { v7 as uuid } from "uuid";

/**
 * Server transport for SSE: this will send messages over an SSE connection and receive messages from HTTP POST requests.
 *
 * This transport is only available in Node.js environments.
 */
export class SSEServerTransport implements Transport {
  private _stream: EventStream | undefined;
  private _sessionId: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /**
   * Creates a new SSE server transport, which will direct the client to POST messages to the relative or absolute URL identified by `_endpoint`.
   */
  constructor(
    private _endpoint: string,
    private stream: EventStream,
  ) {
    this._sessionId = uuid();
  }

  /**
   * Handles the initial SSE connection request.
   *
   * This should be called when a GET request is made to establish the SSE stream.
   */
  async start(): Promise<void> {
    if (this._stream) {
      throw new Error(
        "SSEServerTransport already started! If using Server class, note that connect() calls start() automatically.",
      );
    }

    this._stream = this.stream;

    console.log("Setting up stream handlers");
    this._stream.onClosed(() => {
      this._stream = undefined;
      this.onclose?.();
    });

    // Send the endpoint event
    console.log("Sending endpoint event");
    // await this._stream.push(
    //   `event: endpoint\ndata: ${encodeURI(this._endpoint)}?sessionId=${
    //     this._sessionId
    //   }\n\n`
    // );

    await this._stream.push({
      event: "endpoint",
      data: this._endpoint + `?sessionId=${this._sessionId}`,
    });

    console.log("Sent");

    // await this._stream.send();
  }

  /**
   * Handles incoming POST messages.
   *
   * This should be called when a POST request is made to send a message to the server.
   */
  async handlePostMessage(event: H3Event<EventHandlerRequest>): Promise<void> {
    if (!this._stream) {
      const message = "SSE connection not established";
      throw new Error(message);
    }

    let body: string | unknown;
    try {
      const ct = contentType.parse(getHeader(event, "content-type") ?? "");
      if (ct.type !== "application/json") {
        throw new Error(`Unsupported content-type: ${ct}`);
      }

      body = await readRawBody(
        event,
        (ct.parameters["charset"] ?? "utf8") as Encoding,
      );
    } catch (error) {
      throw createError({
        status: 400,
        statusMessage: String(error),
        message: "Invalid body",
      });
    }

    try {
      await this.handleMessage(
        typeof body === "string" ? JSON.parse(body) : body,
      );
    } catch {
      throw createError({
        status: 400,
        statusMessage: `Invalid message: ${body}`,
        message: "Invalid message",
      });
    }

    return;
  }

  /**
   * Handle a client message, regardless of how it arrived. This can be used to inform the server of messages that arrive via a means different than HTTP POST.
   */
  async handleMessage(message: unknown): Promise<void> {
    let parsedMessage: JSONRPCMessage;
    try {
      parsedMessage = JSONRPCMessageSchema.parse(message);
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }

    this.onmessage?.(parsedMessage);
  }

  async close(): Promise<void> {
    await this._stream?.close();
    this._stream = undefined;
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._stream) {
      throw new Error("Not connected");
    }

    await this._stream.push({
      event: "message",
      data: JSON.stringify(message),
    });
  }

  /**
   * Returns the session ID for this transport.
   *
   * This can be used to route incoming POST requests.
   */
  get sessionId(): string {
    return this._sessionId;
  }
}
