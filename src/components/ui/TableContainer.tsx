import React from "react";
import { ScrollArea } from "@mantine/core";

export function TableContainer({ children }: React.PropsWithChildren) {
  return (
    <ScrollArea className="table-wrap" type="auto" offsetScrollbars>
      {children}
    </ScrollArea>
  );
}
