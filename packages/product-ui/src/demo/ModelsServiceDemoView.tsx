import { useState } from "react";
import { ModelsServiceView } from "../desktop/ModelsServiceView";
import { createModelsServiceFixture } from "./fixtures";

export function ModelsServiceDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createModelsServiceFixture(zh);
  const [selected, setSelected] = useState<string | null>("flowlet-pro");
  return (
    <ModelsServiceView
      stats={fixture.stats}
      groups={fixture.groups}
      labels={fixture.labels}
      density={density}
      selectedId={selected}
      onSelect={setSelected}
    />
  );
}
