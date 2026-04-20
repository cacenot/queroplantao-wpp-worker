import { Elysia } from "elysia";
import type { ApiDeps } from "./deps.ts";
import { moderationConfigModule } from "./modules/moderation-config/index.ts";
import { phoneBlacklistModule } from "./modules/phone-blacklist/index.ts";
import { phoneBypassModule } from "./modules/phone-bypass/index.ts";
import { providerInstancesModule } from "./modules/provider-instances/index.ts";
import { tasksModule } from "./modules/tasks/index.ts";
import { webhooksZapiModule } from "./modules/webhooks-zapi/index.ts";

export interface WebhookConfig {
  secret: string;
  enabled: boolean;
}

export function composeApp(deps: ApiDeps, webhookConfig: WebhookConfig) {
  return new Elysia()
    .use(tasksModule({ taskService: deps.taskService }))
    .use(providerInstancesModule({ instanceService: deps.instanceService }))
    .use(moderationConfigModule({ moderationConfigService: deps.moderationConfigService }))
    .use(phoneBlacklistModule({ phonePoliciesService: deps.phonePoliciesService }))
    .use(phoneBypassModule({ phonePoliciesService: deps.phonePoliciesService }))
    .use(
      webhooksZapiModule({
        groupMessagesService: deps.groupMessagesService,
        instanceService: deps.instanceService,
        webhookSecret: webhookConfig.secret,
        enabled: webhookConfig.enabled,
      })
    );
}
