import type { ReactNode } from "react";
import { OverviewModuleCardView } from "@flowlet/product-ui";

type Props = {
  title: ReactNode;
  description?: ReactNode;
  action?: string;
  onAction?: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
};

export function OverviewModuleCard({ title, description, action, onAction, headerExtra, children }: Props) {
  return (
    <OverviewModuleCardView title={title} description={description} action={action} onAction={onAction} headerExtra={headerExtra}>
      {children}
    </OverviewModuleCardView>
  );
}
