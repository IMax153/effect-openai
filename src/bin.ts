#!/usr/bin/env node

import * as DevTools from "@effect/experimental/DevTools"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Node from "@effect/platform-node/Runtime"
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Cli from "./Cli.js"
import * as OpenAI from "./OpenAI.js"

const OpenAILive = OpenAI.makeLayer({
  apiKey: Config.secret("apiKey"),
  organization: Config.option(Config.secret("organization"))
})

const OtelLive = DevTools.layer().pipe(
  Layer.provideMerge(
    NodeSdk.layer(() => ({
      resource: {
        serviceName: "effect-openai"
      },
      spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
      metricReader: new PrometheusExporter({ port: 9464 })
    }))
  )
)

const TracingLive = Config.boolean("tracing").pipe(
  Config.withDefault(false),
  Effect.map((enabled) => enabled ? OtelLive : Layer.effectDiscard(Effect.unit)),
  Layer.unwrapEffect
)

const ConfigProviderLive = Layer.setConfigProvider(
  ConfigProvider.fromEnv({ pathDelim: "_", seqDelim: "," }).pipe(
    ConfigProvider.nested("openai"),
    ConfigProvider.constantCase
  )
)

const MainLive = NodeContext.layer.pipe(
  Layer.provide(OpenAILive),
  Layer.provide(TracingLive),
  Layer.provide(ConfigProviderLive)
)

Effect.suspend(() => Cli.run(process.argv.slice(2))).pipe(
  Effect.provide(MainLive),
  Node.runMain
)
