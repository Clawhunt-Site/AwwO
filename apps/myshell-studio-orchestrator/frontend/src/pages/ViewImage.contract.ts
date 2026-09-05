import {
  getLibraryDetailStatus,
  normalizeLibraryTaskDetail,
  resolveLibraryDetailMedia,
  type LibraryDetailViewState,
} from './ViewImage';
import type { LibraryGenerateResult } from '../services/api';

const imageTask: LibraryGenerateResult = {
  status: 'done',
  result: {
    outputImg: 'https://example.test/result.png',
    inputImg: ['https://example.test/input.png'],
    width: '768',
    height: '1024',
    errMsg: '',
    outputPreview: '',
    outputPoster: '',
  },
  botId: 'bot-1',
  slugId: 'slug-1',
  taskId: 'task-1',
  startTime: String(Date.now()),
  floorUrl: '',
  botName: 'Contract Bot',
  imageUrl: '',
  botType: 'image',
  likeStatus: '',
  estimateTaskDuration: '300000',
};

const videoTask: LibraryGenerateResult = {
  ...imageTask,
  taskId: 'task-video',
  botType: 'video',
  result: {
    ...imageTask.result,
    outputImg: 'https://example.test/result.mp4',
    outputPoster: 'https://example.test/poster.png',
  },
};

const runningTask: LibraryGenerateResult = {
  ...imageTask,
  status: 'running',
  result: {
    ...imageTask.result,
    outputImg: '',
  },
};

const imageMediaContract = resolveLibraryDetailMedia(imageTask);
const videoMediaContract = resolveLibraryDetailMedia(videoTask);
const runningStatusContract = getLibraryDetailStatus(runningTask);
const snakeCaseEnvelopeContract = normalizeLibraryTaskDetail({
  data: {
    task_id: 'task-snake',
    status: 'done',
    bot_name: 'Snake Case Bot',
    bot_type: 'image',
    image_url: 'https://example.test/cover.png',
    start_time: '2026-06-02T10:30:00Z',
    estimate_task_duration: 300000,
    is_ai_pick: 'true',
    result: {
      output_img: 'https://example.test/snake.png',
      output_preview: 'https://example.test/snake-preview.png',
      output_poster: 'https://example.test/snake-poster.png',
      input_img: 'https://example.test/snake-input.png',
      width: 512,
      height: 768,
      err_msg: '',
    },
  },
});
const mediaEnvelopeContract = normalizeLibraryTaskDetail({
  task: {
    taskId: 'task-top-media',
    status: 'done',
    mediaUrl: 'https://example.test/top-media.webp',
    thumbnailUrl: 'https://example.test/top-media-thumb.webp',
    characterName: 'Top Media Bot',
    mediaType: 'image',
  },
});
const statusEnvelopeContract = normalizeLibraryTaskDetail({
  status: 'ok',
  task: imageTask,
});

const resolvedStateContract: LibraryDetailViewState = {
  task: imageTask,
  media: imageMediaContract,
  status: getLibraryDetailStatus(imageTask),
};

void videoMediaContract;
void runningStatusContract;
void snakeCaseEnvelopeContract;
void mediaEnvelopeContract;
void statusEnvelopeContract;
void resolvedStateContract;
