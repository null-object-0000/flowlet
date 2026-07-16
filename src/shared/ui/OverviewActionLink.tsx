import type { MouseEvent, ReactNode } from "react";
import { Typography } from "@douyinfe/semi-ui-19";
import styles from "./OverviewActionLink.module.css";

const { Text } = Typography;

type Props = {
  children: ReactNode;
  onClick: () => void;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export function OverviewActionLink({ children, onClick, leadingIcon, trailingIcon }: Props) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onClick();
  };

  return (
    <Text
      className={styles.link}
      icon={leadingIcon}
      link={{ href: "#", onClick: handleClick }}
    >
      <span className={styles.content}>
        {children}
        {trailingIcon ? <span className={styles.trailingIcon} aria-hidden="true">{trailingIcon}</span> : null}
      </span>
    </Text>
  );
}
