import type { ZapiReceivedWebhookPayload } from "./webhook-schema.ts";

export type MessageType =
  | "text"
  | "image"
  | "video"
  | "document"
  | "location"
  | "contact"
  | "interactive"
  | "poll"
  | "commerce"
  | "event";

export interface NormalizedZapiMessage {
  providerKind: "whatsapp_zapi";
  protocol: "whatsapp";

  groupExternalId: string;

  senderPhone: string | null;
  senderExternalId: string | null;
  senderName: string | null;

  externalMessageId: string;
  referenceExternalMessageId: string | null;

  messageType: MessageType;
  messageSubtype: string | null;

  hasText: boolean;
  normalizedText: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  mimeType: string | null;
  caption: string | null;

  sentAt: Date;
  fromMe: boolean;
  isForwarded: boolean;
  isEdited: boolean;

  zapi: {
    instanceExternalId: string;
    connectedPhone: string | null;
    chatName: string | null;
    status: string | null;
    senderLid: string | null;
    waitingMessage: boolean | null;
    viewOnce: boolean | null;
    extractedPayload: Record<string, unknown> | null;
    rawPayload: ZapiReceivedWebhookPayload;
  };
}

export type ZapiMessageNormalizerResult =
  | { status: "ignored"; reason: ZapiIgnoreReason }
  | { status: "accepted"; data: NormalizedZapiMessage };

export type ZapiIgnoreReason =
  | "not-group"
  | "newsletter"
  | "broadcast"
  | "from-me"
  | "notification"
  | "status-reply"
  | "waiting-message"
  | "audio"
  | "sticker"
  | "reaction"
  | "gif"
  | "missing-identifiers"
  | "unsupported-content"
  | "no-text-content";

function normalizePhone(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D+/g, "");
  if (!digits) return null;
  return digits;
}

function toDateMillis(momment: number | undefined): Date {
  if (typeof momment !== "number" || !Number.isFinite(momment)) {
    return new Date();
  }
  // momment from Z-API can be seconds or milliseconds; heuristic: < 1e12 = seconds
  const ms = momment < 1e12 ? momment * 1000 : momment;
  return new Date(ms);
}

function trimmed(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isGifMime(mime: string | undefined | null): boolean {
  return typeof mime === "string" && mime.toLowerCase().includes("gif");
}

export function extractZapiGroupMessage(
  payload: ZapiReceivedWebhookPayload
): ZapiMessageNormalizerResult {
  // Ordem de descarte: afasta o que não queremos persistir antes de extrair conteúdo.

  if (payload.isNewsletter === true) {
    return { status: "ignored", reason: "newsletter" };
  }

  if (payload.broadcast === true) {
    return { status: "ignored", reason: "broadcast" };
  }

  if (payload.isGroup !== true) {
    return { status: "ignored", reason: "not-group" };
  }

  if (payload.fromMe === true) {
    return { status: "ignored", reason: "from-me" };
  }

  if (typeof payload.notification === "string" && payload.notification.length > 0) {
    return { status: "ignored", reason: "notification" };
  }

  if (payload.type === "ReplyMessage" && payload.status === "STATUS") {
    return { status: "ignored", reason: "status-reply" };
  }

  if (payload.waitingMessage === true) {
    return { status: "ignored", reason: "waiting-message" };
  }

  if (payload.audio) {
    return { status: "ignored", reason: "audio" };
  }

  if (payload.sticker) {
    return { status: "ignored", reason: "sticker" };
  }

  if (payload.reaction) {
    return { status: "ignored", reason: "reaction" };
  }

  if (isGifMime(payload.image?.mimeType) || isGifMime(payload.video?.mimeType)) {
    return { status: "ignored", reason: "gif" };
  }

  const groupExternalId = trimmed(payload.phone);
  const externalMessageId = trimmed(payload.messageId);

  if (!groupExternalId || !externalMessageId) {
    return { status: "ignored", reason: "missing-identifiers" };
  }

  const senderPhone = normalizePhone(payload.participantPhone);
  const senderExternalId = trimmed(payload.participantLid);
  if (!senderPhone && !senderExternalId) {
    return { status: "ignored", reason: "missing-identifiers" };
  }

  const extracted = extractContent(payload);
  if (!extracted) {
    return { status: "ignored", reason: "unsupported-content" };
  }

  const { messageType, messageSubtype, normalizedText, mediaUrl, thumbnailUrl, mimeType, caption } =
    extracted;

  const hasText = normalizedText !== null && normalizedText.length > 0;
  const hasCaption = caption !== null && caption.length > 0;

  if (!hasText && !hasCaption) {
    // Sem texto e sem caption — moderador só roda em texto.
    return { status: "ignored", reason: "no-text-content" };
  }

  return {
    status: "accepted",
    data: {
      providerKind: "whatsapp_zapi",
      protocol: "whatsapp",
      groupExternalId,
      senderPhone,
      senderExternalId,
      senderName: trimmed(payload.senderName),
      externalMessageId,
      referenceExternalMessageId: trimmed(payload.referenceMessageId),
      messageType,
      messageSubtype,
      hasText,
      normalizedText,
      mediaUrl,
      thumbnailUrl,
      mimeType,
      caption,
      sentAt: toDateMillis(payload.momment),
      fromMe: false,
      isForwarded: payload.forwarded === true,
      isEdited: payload.isEdit === true,
      zapi: {
        instanceExternalId: trimmed(payload.instanceId) ?? "",
        connectedPhone: normalizePhone(payload.connectedPhone),
        chatName: trimmed(payload.chatName),
        status: trimmed(payload.status),
        senderLid: trimmed(payload.participantLid),
        waitingMessage: payload.waitingMessage ?? null,
        viewOnce: payload.viewOnce ?? null,
        extractedPayload: buildExtractedPayload(payload, extracted),
        rawPayload: payload,
      },
    },
  };
}

interface ExtractedContent {
  messageType: MessageType;
  messageSubtype: string | null;
  normalizedText: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  mimeType: string | null;
  caption: string | null;
}

function extractContent(payload: ZapiReceivedWebhookPayload): ExtractedContent | null {
  if (payload.text?.message && payload.text.message.length > 0) {
    return {
      messageType: "text",
      messageSubtype: null,
      normalizedText: trimmed(payload.text.message),
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: null,
    };
  }

  if (payload.image) {
    return {
      messageType: "image",
      messageSubtype: null,
      normalizedText: null,
      mediaUrl: trimmed(payload.image.imageUrl),
      thumbnailUrl: trimmed(payload.image.thumbnailUrl),
      mimeType: trimmed(payload.image.mimeType),
      caption: trimmed(payload.image.caption),
    };
  }

  if (payload.video) {
    return {
      messageType: "video",
      messageSubtype: null,
      normalizedText: null,
      mediaUrl: trimmed(payload.video.videoUrl),
      thumbnailUrl: trimmed(payload.video.thumbnailUrl),
      mimeType: trimmed(payload.video.mimeType),
      caption: trimmed(payload.video.caption),
    };
  }

  if (payload.document) {
    return {
      messageType: "document",
      messageSubtype: null,
      normalizedText: null,
      mediaUrl: trimmed(payload.document.documentUrl),
      thumbnailUrl: null,
      mimeType: trimmed(payload.document.mimeType),
      caption: trimmed(payload.document.caption ?? payload.document.fileName),
    };
  }

  if (payload.location) {
    const summary = [trimmed(payload.location.name), trimmed(payload.location.address)]
      .filter((v): v is string => v !== null)
      .join(" — ");
    return {
      messageType: "location",
      messageSubtype: null,
      normalizedText: null,
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: summary.length > 0 ? summary : null,
    };
  }

  if (payload.contact) {
    return {
      messageType: "contact",
      messageSubtype: null,
      normalizedText: null,
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: trimmed(payload.contact.displayName),
    };
  }

  if (payload.poll) {
    return {
      messageType: "poll",
      messageSubtype: null,
      normalizedText: trimmed(payload.poll.name),
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: null,
    };
  }

  if (payload.listResponseMessage) {
    return {
      messageType: "interactive",
      messageSubtype: "list_response",
      normalizedText: trimmed(payload.listResponseMessage.message),
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: trimmed(payload.listResponseMessage.title),
    };
  }

  if (payload.buttonsResponseMessage) {
    return {
      messageType: "interactive",
      messageSubtype: "buttons_response",
      normalizedText: trimmed(payload.buttonsResponseMessage.message),
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: null,
    };
  }

  if (payload.hydratedTemplate) {
    return {
      messageType: "interactive",
      messageSubtype: "hydrated_template",
      normalizedText: trimmed(payload.hydratedTemplate.message),
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: trimmed(payload.hydratedTemplate.title ?? payload.hydratedTemplate.footer),
    };
  }

  if (payload.product) {
    return {
      messageType: "commerce",
      messageSubtype: "product",
      normalizedText: null,
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: null,
    };
  }

  if (payload.event) {
    return {
      messageType: "event",
      messageSubtype: null,
      normalizedText: null,
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: null,
    };
  }

  return null;
}

function buildExtractedPayload(
  payload: ZapiReceivedWebhookPayload,
  extracted: ExtractedContent
): Record<string, unknown> {
  return {
    messageType: extracted.messageType,
    messageSubtype: extracted.messageSubtype,
    normalizedText: extracted.normalizedText,
    caption: extracted.caption,
    mediaUrl: extracted.mediaUrl,
    thumbnailUrl: extracted.thumbnailUrl,
    mimeType: extracted.mimeType,
    type: payload.type ?? null,
    status: payload.status ?? null,
  };
}
