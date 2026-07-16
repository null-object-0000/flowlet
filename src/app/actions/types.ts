import { useFlowletData } from "../useFlowletData";

export type FlowletData = ReturnType<typeof useFlowletData>;
export type SetMessage = (message: string) => void;

export type ActionContext = {
  data: FlowletData;
  setMessage: SetMessage;
};
