import React from "react";
import { ThresholdPicker } from "./budget/threshold-picker.jsx";
import { BudgetEditor } from "./budget/budget-editor.jsx";

export const Budget = () => (
  <div className="a-route a-budget-tab">
    <BudgetEditor />
    <ThresholdPicker />
  </div>
);
