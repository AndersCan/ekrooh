export const VERSION = 1;

export const MessageType = {
  ENVELOPE: 1,
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];
