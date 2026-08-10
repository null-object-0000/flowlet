import { ChannelBrandLogoView } from "@flowlet/product-ui";

export function ChannelBrandLogo({ channelId, name }: { channelId: string; name: string }) {
  return <ChannelBrandLogoView channelId={channelId} name={name} />;
}
