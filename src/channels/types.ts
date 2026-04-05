export interface ChannelAdapter {
  start(): Promise<void>;
  sendMessage(groupId: string, text: string): Promise<void>;
  sendReply(groupId: string, replyToMessageId: string, text: string): Promise<void>;
  sendFile(groupId: string, buffer: Buffer, filename: string, mimeType: string, caption?: string): Promise<void>;
  stop(): Promise<void>;
}

export type MessageHandler = (groupId: string, platform: 'whatsapp' | 'telegram') => Promise<void>;
