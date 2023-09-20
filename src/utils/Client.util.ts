/*
Copyright 2022 The Dapr Authors
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { randomUUID } from "crypto";
import { Map } from "google-protobuf";

import { ConfigurationItem as ConfigurationItemProto } from "../proto/dapr/proto/common/v1/common_pb";
import { isCloudEvent } from "./CloudEvent.util";

import { KeyValueType } from "../types/KeyValue.type";
import { ConfigurationType } from "../types/configuration/Configuration.type";
import { ConfigurationItem } from "../types/configuration/ConfigurationItem";
import { PubSubBulkPublishEntry } from "../types/pubsub/PubSubBulkPublishEntry.type";
import { PubSubBulkPublishResponse } from "../types/pubsub/PubSubBulkPublishResponse.type";
import { PubSubBulkPublishMessage } from "../types/pubsub/PubSubBulkPublishMessage.type";
import { PubSubBulkPublishApiResponse } from "../types/pubsub/PubSubBulkPublishApiResponse.type";
import { DaprClientOptions } from "../types/DaprClientOptions";
import CommunicationProtocolEnum from "../enum/CommunicationProtocol.enum";
import { Settings } from "./Settings.util";
import { LoggerOptions } from "../types/logger/LoggerOptions";
import { StateConsistencyEnum } from "../enum/StateConsistency.enum";
import { StateConcurrencyEnum } from "../enum/StateConcurrency.enum";
import { URLSearchParams } from "url";
/**
 * Adds metadata to a map.
 * @param map Input map
 * @param metadata key value pair of metadata
 */
export function addMetadataToMap(map: Map<string, string>, metadata: KeyValueType = {}): void {
  for (const [key, value] of Object.entries(metadata)) {
    map.set(key, value);
  }
}

/**
 * Converts one or multiple sets of data to a querystring
 * Each set of data contains a set of KeyValue Pair
 * An optional "metadata" type can be added in each set, in which case
 * the QS key of each data in the set will be prefixed with "metadata.".
 *
 * Note, the returned value does not contain the "?" prefix.
 *
 * @param params one of multiple set of data
 * @returns HTTP query parameter string
 */
export function createHTTPQueryParam(...params: { data?: KeyValueType; type?: "metadata" }[]): string {
  const queryBuilder = new URLSearchParams();

  for (const group of params) {
    if (!group?.data) {
      continue;
    }

    for (const [key, value] of Object.entries(group.data)) {
      let propName = key;
      if (group?.type === "metadata") {
        propName = `metadata.${propName}`;
      }

      if (value !== undefined) {
        queryBuilder.set(propName, value);
      }
    }
  }

  return queryBuilder.toString();
}

/**
 * Return the string representation of a valid consistency configuration
 * @param c
 */
export function getStateConsistencyValue(c?: StateConsistencyEnum): "eventual" | "strong" | undefined {
  switch (c) {
    case StateConsistencyEnum.CONSISTENCY_EVENTUAL:
      return "eventual";
    case StateConsistencyEnum.CONSISTENCY_STRONG:
      return "strong";
    default:
      return undefined;
  }
}

/**
 * Return the string representation of a valid concurrency configuration
 * @param c
 */
export function getStateConcurrencyValue(c?: StateConcurrencyEnum): "first-write" | "last-write" | undefined {
  switch (c) {
    case StateConcurrencyEnum.CONCURRENCY_FIRST_WRITE:
      return "first-write";
    case StateConcurrencyEnum.CONCURRENCY_LAST_WRITE:
      return "last-write";
    default:
      return undefined;
  }
}

/**
 * Converts a Map<string, common_pb.ConfigurationItemProto> to a ConfigurationType object.
 * @param Map<string, common_pb.ConfigurationItemProto>
 * @returns ConfigurationType object
 */
export function createConfigurationType(configDict: Map<string, ConfigurationItemProto>): ConfigurationType {
  const configMap: { [k: string]: ConfigurationItem } = {};

  configDict.forEach(function (v, k) {
    const item: ConfigurationItem = {
      key: k,
      value: v.getValue(),
      version: v.getVersion(),
      metadata: v
        .getMetadataMap()
        .toObject()
        .reduce((result: object, [key, value]) => {
          // @ts-ignore
          result[key] = value;
          return result;
        }, {}),
    };
    configMap[k] = item;
  });
  return configMap;
}

/**
 * Gets the Content-Type for the input data.
 *
 * If the data is a valid Cloud Event, the Content-Type is "application/cloudevents+json".
 * If the data is a JSON object, the Content-Type is "application/json".
 * If the data is a string, the Content-Type is "text/plain".
 * Otherwise, the Content-Type is "application/octet-stream".
 *
 * @param data input data
 * @returns Content-Type header value
 */
export function getContentType(data: any): string {
  // Identify the exact type of the input data
  const type = getType(data);

  switch (type) {
    case "Array":
    case "Object":
      if (isCloudEvent(data as object)) {
        return "application/cloudevents+json";
      } else {
        return "application/json";
      }
    case "Boolean":
    case "Number":
    case "String":
      return "text/plain";
    // Uint8Array, Int8Array, Buffer, SlowBuffer, Blob, etc.
    default:
      return "application/octet-stream";
  }
}

/**
 * Get the entries for bulk publish request.
 * If entryIDs are missing, generate UUIDs for them.
 * If contentTypes are missing, infer them based on the data using {@link getContentType}.
 *
 * @param messages pubsub bulk publish messages
 * @returns configured entries
 */
export function getBulkPublishEntries(messages: PubSubBulkPublishMessage[]): PubSubBulkPublishEntry[] {
  return messages.map((message) => {
    // If message is a PubSubBulkPublishEntry, use it directly
    if (typeof message !== "string" && "event" in message) {
      return {
        entryID: message.entryID ? message.entryID : randomUUID(),
        event: message.event,
        contentType: message.contentType ? message.contentType : getContentType(message.event),
        metadata: message.metadata ? message.metadata : {},
      };
    }
    // Otherwise, create a PubSubBulkPublishEntry from the message
    return {
      entryID: randomUUID(),
      event: message,
      contentType: getContentType(message),
      metadata: {},
    };
  });
}

/**
 * Get the response for bulk publish request.
 *
 * @param response bulk publish API response
 * @param entries entries for bulk publish request
 * @param error error from bulk publish request
 * @returns SDK response for bulk publish request
 */
export function getBulkPublishResponse(
  params:
    | {
        entries: PubSubBulkPublishEntry[];
        response: PubSubBulkPublishApiResponse;
      }
    | {
        entries: PubSubBulkPublishEntry[];
        error: Error;
      },
): PubSubBulkPublishResponse {
  if ("error" in params) {
    // The entire request failed. This typically indicates a problem with the request or the connection.
    const failedMessages = params.entries.map((message) => ({ message, error: params.error }));
    return { failedMessages };
  }

  // Some or all of the entries failed to be published.
  return {
    failedMessages:
      params.response.failedEntries.flatMap((entry) => {
        const message = params.entries.find((message) => message.entryID === entry.entryID);
        if (!message) {
          return [];
        }
        return { message, error: new Error(entry.error) };
      }) ?? [],
  };
}

/**
 * Determine the type of the input data by checking the constructor name
 * If no name is found, we return the typeof the input data
 *
 * @param arr
 * @returns string The Data Type, e.g., Uint8Array, Int8Array, Buffer, SlowBuffer, Blob, Oject, Array, etc.
 */
function getType(o: any) {
  // If the type is set in the constructor name, return the name
  // e.g., Uint8Array, Int8Array, Buffer, SlowBuffer, Blob, etc.
  if (o.constructor.name) {
    return o.constructor.name;
  }

  return typeof o;
}

/**
 * Prepares DaprClientOptions for use by the DaprClient/DaprServer.
 * If the user does not provide a value for a mandatory option, the default value is used.
 * @param clientoptions DaprClientOptions
 * @param defaultCommunicationProtocol CommunicationProtocolEnum
 * @returns DaprClientOptions
 */
export function getClientOptions(
  clientoptions: Partial<DaprClientOptions> | undefined,
  defaultCommunicationProtocol: CommunicationProtocolEnum,
  defaultLoggerOptions: LoggerOptions | undefined,
): DaprClientOptions {
  const clientCommunicationProtocol = clientoptions?.communicationProtocol ?? defaultCommunicationProtocol;

  // We decide the host/port/endpoint here
  let daprEndpoint = "";
  if (clientCommunicationProtocol == CommunicationProtocolEnum.HTTP) {
    daprEndpoint = Settings.getDefaultHttpEndpoint();
  } else if (clientCommunicationProtocol == CommunicationProtocolEnum.GRPC) {
    daprEndpoint = Settings.getDefaultGrpcEndpoint();
  }

  let host = Settings.getDefaultHost();
  let port = Settings.getDefaultPort(clientCommunicationProtocol);
  
  if (clientoptions?.daprHost || clientoptions?.daprPort) {
    host = clientoptions?.daprHost ?? host;
    port = clientoptions?.daprPort ?? port;
  } else if (daprEndpoint != "") {
    const [scheme, fqdn, p] = parseEndpoint(daprEndpoint);
    host = `${scheme}://${fqdn}`;
    port = p.toString();
  }

  return {
    daprHost: host,
    daprPort: port,
    communicationProtocol: clientCommunicationProtocol,
    isKeepAlive: clientoptions?.isKeepAlive,
    logger: clientoptions?.logger ?? defaultLoggerOptions,
    actor: clientoptions?.actor,
    daprApiToken: clientoptions?.daprApiToken,
    maxBodySizeMb: clientoptions?.maxBodySizeMb,
  };
}

/**
 * Scheme, fqdn and port
 */
type EndpointTuple = [string, string, number];

/**
 * Parses an endpoint to scheme, fqdn and port
 * @param address Endpoint address
 * @returns EndpointTuple (scheme, fqdn, port)
 */
export function parseEndpoint(address: string): EndpointTuple {
  let scheme = "http";
  let fqdn = "localhost";
  let port = 80;
  let addr = address;

  const addrList = address.split("://");

  if (addrList.length === 2) {
    // A scheme was explicitly specified
    scheme = addrList[0];
    if (scheme === "https") {
      port = 443;
    }
    addr = addrList[1];
  }

  const addrParts = addr.split(":");
  if (addrParts.length === 2) {
    // A port was explicitly specified
    if (addrParts[0].length > 0) {
      fqdn = addrParts[0];
    }
    // Account for Endpoints of the type http://localhost:3500/v1.0/invoke
    const portParts = addrParts[1].split("/");
    port = parseInt(portParts[0], 10);
  } else if (addrParts.length === 1) {
    // No port was specified
    // Account for Endpoints of the type :3500/v1.0/invoke
    const fqdnParts = addrParts[0].split("/");
    fqdn = fqdnParts[0];
  } else {
    // IPv6 address
    const ipv6Parts = addr.split("]:");
    if (ipv6Parts.length === 2) {
      // A port was explicitly specified
      fqdn = ipv6Parts[0].replace("[", "");
      const portParts = ipv6Parts[1].split("/");
      port = parseInt(portParts[0], 10);
    } else if (ipv6Parts.length === 1) {
      // No port was specified
      const fqdnParts = ipv6Parts[0].split("/");
      fqdn = fqdnParts[0].replace("[", "").replace("]", "");
    } else {
      throw new Error(`Invalid address: ${address}`);
    }
  }

  if (isNaN(port)) {
    throw new Error(`Invalid port: ${port}`);
  }

  return [scheme, fqdn, port];
}
