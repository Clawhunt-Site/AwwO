import { http, HttpResponse } from 'msw';
import {
  mockInitResponse,
  mockExploreFloors,
  mockBotDetailResponse,
  mockLibraryItems,
  mockEnergyHistory,
  mockRecommendations,
  mockEarnData,
  mockEnergyPacks,
} from './data';

const API = '*/v1/telegram/miniapp/dreamy';

export const handlers = [
  // ── Init ──
  http.post(`${API}/init`, () => {
    return HttpResponse.json(mockInitResponse);
  }),

  // ── Explore ──
  http.post(`${API}/explore`, async ({ request }) => {
    const body = (await request.json()) as { floor_url?: string; page?: number; page_size?: number };
    const floorUrl = body.floor_url;
    const floors = floorUrl
      ? mockExploreFloors.filter(f => f.floorUrl === floorUrl)
      : mockExploreFloors;

    return HttpResponse.json({
      floors,
      total: floors.reduce((sum, f) => sum + (f.images?.length ?? 0), 0),
      page: body.page ?? 1,
      pageSize: body.page_size ?? 20,
      hasMore: false,
    });
  }),

  // ── Bot Detail ──
  http.post(`${API}/get-by-slug`, async ({ request }) => {
    const body = (await request.json()) as { slug_id?: string };
    // Always return the same mock; stories can override per-story if needed
    const slugId = body.slug_id ?? 'luna-star';
    return HttpResponse.json({
      ...mockBotDetailResponse,
      info: {
        ...mockBotDetailResponse.info,
        slugId,
      },
    });
  }),

  // ── Library (all / in-progress) ──
  http.post(`${API}/library`, () => {
    return HttpResponse.json({
      generateResults: mockLibraryItems,
    });
  }),

  // ── Library (paginated, completed) ──
  http.post(`${API}/library/list`, () => {
    const completed = mockLibraryItems.filter(item => item.status === 'done');
    return HttpResponse.json({
      items: completed.map((item, i) => ({
        id: i + 1,
        taskId: item.taskId,
        mediaUrl: item.result.outputImg,
        thumbnailUrl: item.result.outputPreview || item.result.outputImg,
        mediaType: item.botType === 'video' ? 'video' : 'image',
        characterName: item.botName,
        likeStatus: Number(item.likeStatus) || 0,
        durationSeconds: item.botType === 'video' ? 12 : 0,
        width: Number(item.result.width) || 512,
        height: Number(item.result.height) || 768,
        createdAt: item.startTime,
      })),
      hasMore: false,
      lastId: completed.length,
    });
  }),

  // ── Library feedback ──
  http.post(`${API}/library/feedback`, async ({ request }) => {
    const body = (await request.json()) as { status: number };
    return HttpResponse.json({ status: body.status });
  }),

  // ── Library delete ──
  http.post(`${API}/library/delete`, () => {
    return HttpResponse.json({});
  }),

  // ── Energy History ──
  http.post(`${API}/energy/history`, () => {
    return HttpResponse.json({
      records: mockEnergyHistory,
      total: mockEnergyHistory.length,
      page: 1,
      pageSize: 20,
    });
  }),

  // ── Generate ──
  http.post(`${API}/generate`, () => {
    return HttpResponse.json({
      outputJobId: 'job_mock_001',
      leftTry: 2,
      totalTimes: 5,
      currentTimes: 3,
      queuePosition: 0,
    });
  }),

  // ── Generate Result ──
  http.post(`${API}/generate/result`, () => {
    return HttpResponse.json({
      tasks: [
        {
          status: 'done',
          result: JSON.stringify({
            outputImg: 'https://placehold.co/512x768/1d1c1f/f5f5f6?text=Generated',
            width: '512',
            height: '768',
          }),
          slugId: 'luna-star',
          jobId: 'job_mock_001',
          startTime: '2026-04-23T10:00:00Z',
          floorUrl: 'celeb-sex',
          botName: 'Luna Star',
          creatorName: 'dreamy_user_42',
          creatorAvatar: 'https://placehold.co/80x80/1d1c1f/f5f5f6?text=U',
          queuePosition: 0,
        },
      ],
    });
  }),

  // ── Recommendations ──
  http.post(`${API}/recommendations`, () => {
    return HttpResponse.json({
      recommendations: mockRecommendations,
    });
  }),

  // ── Earn ──
  http.post(`${API}/earn`, () => {
    return HttpResponse.json(mockEarnData);
  }),

  // ── Energy Packs ──
  http.post(`${API}/energy-packs`, () => {
    return HttpResponse.json({ energyPacks: mockEnergyPacks });
  }),

  // ── Upload Presign URL ──
  http.post(`${API}/get_upload_presign_url`, () => {
    return HttpResponse.json({
      uploadUrl: 'https://mock-s3.example.com/upload?presigned=true',
      objectAccessUrl: 'https://mock-cdn.example.com/uploads/mock-image-001.jpg',
      contentType: 'image/jpeg',
      expiresAt: '2026-04-24T00:00:00Z',
    });
  }),

  // ── S3 PUT (accept the upload silently) ──
  http.put('https://mock-s3.example.com/*', () => {
    return new HttpResponse(null, { status: 200 });
  }),

  // ── Create Invoice ──
  http.post(`${API}/create_invoice`, () => {
    return HttpResponse.json({
      invoiceLink: 'https://t.me/$mock_invoice_link_abc123',
    });
  }),

  // ── Task running check ──
  http.post(`${API}/task/running`, () => {
    return HttpResponse.json({ running: false });
  }),

  // ── Task detail ──
  http.post(`${API}/task/detail`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { task_id?: string; taskId?: string };
    const taskId = body.task_id || body.taskId || '';
    const task = mockLibraryItems.find((item) => item.taskId === taskId) || mockLibraryItems[0];
    return HttpResponse.json({ task });
  }),

  // ── Task actions (like, retry, delete, cancel) ──
  http.post(`${API}/task/like`, async ({ request }) => {
    const body = (await request.json()) as { status: number };
    return HttpResponse.json({ status: body.status });
  }),

  http.post(`${API}/task/retry`, () => HttpResponse.json({})),
  http.post(`${API}/task/delete`, () => HttpResponse.json({})),
  http.post(`${API}/task/cancel`, () => HttpResponse.json({})),

  // ── Share ──
  http.post(`${API}/share/create`, () => {
    return HttpResponse.json({
      share_token: 'share_mock_token_xyz',
      share_link: 'https://t.me/DreamyPornBot?start=share_mock_token_xyz',
      prepared_message_id: 'msg_001',
    });
  }),

  http.post(`${API}/share/opened`, () => HttpResponse.json({})),

  // ── Invite opened ──
  http.post(`${API}/invite/opened`, () => HttpResponse.json({})),

  // ── Task download telemetry ──
  http.post(`${API}/task/download`, () => HttpResponse.json({})),

  // ── Language ──
  http.post(`${API}/language/set`, async ({ request }) => {
    const body = (await request.json()) as { language: string };
    return HttpResponse.json({ success: true, language: body.language });
  }),

  // ── Footer ──
  http.post(`${API}/footer`, () => {
    return HttpResponse.json({
      footers: [
        {
          title: 'Terms of Service',
          imageUrl: 'https://placehold.co/40x40/1d1c1f/f5f5f6?text=ToS',
          gotoLink: 'https://example.com/tos',
        },
        {
          title: 'Privacy Policy',
          imageUrl: 'https://placehold.co/40x40/1d1c1f/f5f5f6?text=PP',
          gotoLink: 'https://example.com/privacy',
        },
      ],
    });
  }),

  // ── Form config (different prefix) ──
  http.post('*/v1/shellchannel/telegram/miniapp/get_form_by_app_id', () => {
    return HttpResponse.json({
      formData: JSON.stringify({
        title: 'Luna Star',
        description: 'Upload a photo to generate with Luna Star',
        button_text: 'Generate',
        form: [
          {
            title: 'Upload your photo',
            component: 'Uploader',
            index: 0,
            options: [],
            default: '',
            required: true,
          },
          {
            title: 'Style',
            component: 'RadioGroup',
            index: 1,
            options: [
              { label: 'Realistic', value: 'realistic' },
              { label: 'Anime', value: 'anime' },
            ],
            default: 'realistic',
            required: true,
          },
        ],
      }),
    });
  }),
];
