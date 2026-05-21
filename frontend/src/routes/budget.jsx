import React from "react";
import { ThresholdPicker } from "./budget/threshold-picker.jsx";
import { BudgetEditor } from "./budget/budget-editor.jsx";
import { BurnRatePanel } from "./budget/burn-rate-panel.jsx";
import { ProjectAllocation } from "./budget/project-allocation.jsx";
import { BudgetHistoryTable } from "./budget/budget-history-table.jsx";

export const Budget = () => (
  <div className="a-route a-budget-tab">
    <BudgetEditor />
    <ThresholdPicker />
    <BurnRatePanel />
    <ProjectAllocation />
    <BudgetHistoryTable />
  </div>
);
