import React from "react";
import { DeepSeek, LongCat } from "@lobehub/icons";
import { IconServer } from "@tabler/icons-react";

type ChannelLogoVariant = "avatar" | "color";

interface ChannelLogoProps {
  channelId: string;
  channelName?: string;
  size?: number;
  variant?: ChannelLogoVariant;
  className?: string;
}

type IconComponent = React.ComponentType<{ size?: number; className?: string }>;

interface ChannelIcon {
  avatar: IconComponent;
  color: IconComponent;
}

const channelIconMap: Record<string, ChannelIcon> = {
  deepseek: { avatar: DeepSeek.Avatar as IconComponent, color: DeepSeek.Color as IconComponent },
  longcat: { avatar: LongCat.Avatar as IconComponent, color: LongCat.Color as IconComponent },
};

function InitialFallback({ channelId, channelName, size, className }: Required<Pick<ChannelLogoProps, "channelId" | "size">> & Pick<ChannelLogoProps, "channelName" | "className">) {
  const label = (channelName && channelName.trim())
    ? channelName.trim().charAt(0).toUpperCase()
    : (channelId && channelId.trim())
      ? channelId.trim().charAt(0).toUpperCase()
      : null;

  if (!label) {
    const iconSize = size;
    return (
      <span
        className={className}
        style={{
          width: iconSize,
          height: iconSize,
          display: "inline-grid",
          placeItems: "center",
          borderRadius: Math.max(4, Math.round(iconSize * 0.25)),
          background: "#e2e8f0",
          color: "#64748b",
        }}
        aria-hidden="true"
      >
        <IconServer size={Math.round(iconSize * 0.6)} stroke={1.6} />
      </span>
    );
  }

  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        display: "inline-grid",
        placeItems: "center",
        borderRadius: Math.max(4, Math.round(size * 0.22)),
        background: "#e2e8f0",
        color: "#475569",
        fontSize: Math.round(size * 0.42),
        fontWeight: 700,
        lineHeight: 1,
      }}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}

export function ChannelLogo({
  channelId,
  channelName,
  size = 20,
  variant = "color",
  className,
}: ChannelLogoProps) {
  const icon = channelIconMap[channelId]?.[variant];

  if (!icon) {
    return <InitialFallback channelId={channelId} channelName={channelName} size={size} className={className} />;
  }

  const Comp = icon;
  return <Comp size={size} className={className} />;
}
