import { useEffect, useMemo, useState } from 'react';

import {
  estimateGenerationTaskCost,
  formatGenerationTaskParamSummary,
  getDefaultGenerationAspectRatio,
  getDefaultGenerationMode,
  getDefaultGenerationModel,
  getGenerationTaskKey,
  normalizeGenerationTaskSettings,
} from '../model/canvasProWorkspace';
import type { GenerationTask } from '../model/canvasProWorkspace';

export function useCanvasProGenerationDrafts(generationTasks: GenerationTask[], reloadKey: number) {
  const [selectedGenerationTaskId, setSelectedGenerationTaskId] = useState('');
  const [taskAspectRatioDraft, setTaskAspectRatioDraft] = useState(getDefaultGenerationAspectRatio('image'));
  const [taskDurationDraft, setTaskDurationDraft] = useState(5);
  const [taskModeDraft, setTaskModeDraft] = useState(getDefaultGenerationMode('image'));
  const [taskModelDraft, setTaskModelDraft] = useState(getDefaultGenerationModel('image'));
  const [taskOutputCountDraft, setTaskOutputCountDraft] = useState(1);
  const [taskPromptDraft, setTaskPromptDraft] = useState('');
  const [taskQualityDraft, setTaskQualityDraft] = useState('balanced');
  const [taskResolutionDraft, setTaskResolutionDraft] = useState('2K');

  const selectedGenerationTask = useMemo(() => {
    if (!generationTasks.length) return null;
    return (
      generationTasks.find((task) => getGenerationTaskKey(task) === selectedGenerationTaskId) ||
      generationTasks[0]
    );
  }, [generationTasks, selectedGenerationTaskId]);
  const selectedGenerationTaskKey = getGenerationTaskKey(selectedGenerationTask);
  const selectedGenerationTaskAtomCommand =
    selectedGenerationTask?.executor?.commandPreview || selectedGenerationTask?.executor?.capabilityId || '';
  const taskCostEstimate = useMemo(
    () =>
      estimateGenerationTaskCost(selectedGenerationTask?.kind, {
        aspectRatio: taskAspectRatioDraft,
        durationSeconds: taskDurationDraft,
        mode: taskModeDraft,
        model: taskModelDraft,
        outputCount: taskOutputCountDraft,
        quality: taskQualityDraft,
        resolution: taskResolutionDraft,
      }),
    [
      selectedGenerationTask?.kind,
      taskAspectRatioDraft,
      taskDurationDraft,
      taskModeDraft,
      taskModelDraft,
      taskOutputCountDraft,
      taskQualityDraft,
      taskResolutionDraft,
    ],
  );
  const taskParamSummary = useMemo(
    () =>
      formatGenerationTaskParamSummary(
        selectedGenerationTask?.kind,
        {
          aspectRatio: taskAspectRatioDraft,
          durationSeconds: taskDurationDraft,
          mode: taskModeDraft,
          model: taskModelDraft,
          outputCount: taskOutputCountDraft,
          quality: taskQualityDraft,
          resolution: taskResolutionDraft,
        },
        taskCostEstimate,
        selectedGenerationTask?.sourceInputs || [],
      ),
    [
      selectedGenerationTask?.kind,
      selectedGenerationTask?.sourceInputs,
      taskAspectRatioDraft,
      taskCostEstimate,
      taskDurationDraft,
      taskModeDraft,
      taskModelDraft,
      taskOutputCountDraft,
      taskQualityDraft,
      taskResolutionDraft,
    ],
  );

  useEffect(() => {
    setSelectedGenerationTaskId('');
    setTaskAspectRatioDraft(getDefaultGenerationAspectRatio('image'));
    setTaskDurationDraft(5);
    setTaskModeDraft(getDefaultGenerationMode('image'));
    setTaskModelDraft(getDefaultGenerationModel('image'));
    setTaskOutputCountDraft(1);
    setTaskPromptDraft('');
    setTaskQualityDraft('balanced');
    setTaskResolutionDraft('2K');
  }, [reloadKey]);

  useEffect(() => {
    if (!selectedGenerationTask) {
      setSelectedGenerationTaskId('');
      setTaskAspectRatioDraft(getDefaultGenerationAspectRatio('image'));
      setTaskDurationDraft(5);
      setTaskModeDraft(getDefaultGenerationMode('image'));
      setTaskModelDraft(getDefaultGenerationModel('image'));
      setTaskOutputCountDraft(1);
      setTaskPromptDraft('');
      setTaskQualityDraft('balanced');
      setTaskResolutionDraft('2K');
      return;
    }
    const settings = normalizeGenerationTaskSettings(selectedGenerationTask);
    setSelectedGenerationTaskId(selectedGenerationTaskKey);
    setTaskAspectRatioDraft(settings.aspectRatio);
    setTaskDurationDraft(settings.durationSeconds || 5);
    setTaskModeDraft(settings.mode);
    setTaskModelDraft(settings.model);
    setTaskOutputCountDraft(settings.outputCount);
    setTaskPromptDraft(selectedGenerationTask.prompt || '');
    setTaskQualityDraft(settings.quality);
    setTaskResolutionDraft(settings.resolution);
  }, [selectedGenerationTask, selectedGenerationTaskKey]);

  return {
    selectedGenerationTask,
    selectedGenerationTaskAtomCommand,
    selectedGenerationTaskId,
    selectedGenerationTaskKey,
    setSelectedGenerationTaskId,
    setTaskAspectRatioDraft,
    setTaskDurationDraft,
    setTaskModeDraft,
    setTaskModelDraft,
    setTaskOutputCountDraft,
    setTaskPromptDraft,
    setTaskQualityDraft,
    setTaskResolutionDraft,
    taskAspectRatioDraft,
    taskCostEstimate,
    taskDurationDraft,
    taskModeDraft,
    taskModelDraft,
    taskOutputCountDraft,
    taskParamSummary,
    taskPromptDraft,
    taskQualityDraft,
    taskResolutionDraft,
  };
}
