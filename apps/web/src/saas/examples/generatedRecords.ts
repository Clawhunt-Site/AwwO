/** Public, curated snapshots contain no tenant, canvas, session or private run identifiers. */
export type OfficialRunNodeStatus = 'done' | 'failed' | 'blocked' | 'canceled' | 'cached';
export interface OfficialGeneratedRecord {
  readonly model: string;
  readonly capturedOn: string;
  readonly completed: number;
  readonly total: number;
  readonly artifactNodeId: string;
  readonly reused?: number;
  readonly originalSHA256?: string;
  readonly sourceSHA256: string;
  readonly nodes: Readonly<Record<string, OfficialRunNodeStatus>>;
  readonly note: Readonly<{ zh: string; en: string }>;
  readonly verification: Readonly<{ zh: string; en: string }>;
}
/** The official examples' real runs of 2026-10-12 on Claude Opus 5.5 (written by .local/official-cases/records.ts from
 * the runs and the browser QA). Each page is generated/official/<id>.ts, exactly as its node delivered it. */
export const OFFICIAL_GENERATED_RECORDS: Readonly<Partial<Record<string, OfficialGeneratedRecord>>> = {
  "colony-command": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 13,
    "total": 13,
    "artifactNodeId": "repair",
    "sourceSHA256": "1b845a7950c0e87c6a24ffd78277328ca6e41bc86396bc1f25a02c98e5381509",
    "nodes": {
      "mission": "done",
      "planet": "done",
      "economy": "done",
      "research": "done",
      "art": "done",
      "replay": "done",
      "engine": "done",
      "interface": "done",
      "build": "done",
      "check": "done",
      "repair": "done",
      "accept": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 13/13 个节点全部完成，模型为 Claude Opus 5.5。画布里的媒体节点在同一次运行中生成了 1 张配图，页面直接使用。右侧是「有界规则修复」节点交付的原始页面，未做修改。",
      "en": "All 13/13 workflow nodes completed on Claude Opus 5.5. In the same run, the canvas's media nodes generated 1 picture, which the page shows. The right pane is the original page that the “Bounded rules repair” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错，1 张生成图片正常显示；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors, and its 1 generated picture shows; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "dispatch-network": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 12,
    "total": 12,
    "artifactNodeId": "deliver",
    "sourceSHA256": "afc715333a81747d772be19cee28a54997b8e56cfcf2fdb21fadbfefb03657ac",
    "nodes": {
      "scope": "done",
      "data": "done",
      "model": "done",
      "ux": "done",
      "engine": "done",
      "views": "done",
      "build": "done",
      "checks": "done",
      "repair": "done",
      "recheck": "done",
      "deliver": "done",
      "guide": "done"
    },
    "note": {
      "zh": "本次工作流 12/12 个节点全部完成，模型为 Claude Opus 5.5。右侧是「交付行业演示文件」节点交付的原始页面，未做修改。",
      "en": "All 12/12 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “Deliver the industry demonstration” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "research-atlas": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 12,
    "total": 12,
    "artifactNodeId": "repair",
    "sourceSHA256": "cde1e64d90a73e0ff75aae02174c6f2941c0b98dbccf5b63504414ace223a700",
    "nodes": {
      "scope": "done",
      "corpus": "done",
      "search": "done",
      "claims": "done",
      "visibility": "done",
      "eval": "done",
      "integrate": "done",
      "build": "done",
      "verify": "done",
      "repair": "done",
      "retest": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 12/12 个节点全部完成，模型为 Claude Opus 5.5。右侧是「一次有界修复」节点交付的原始页面，未做修改。",
      "en": "All 12/12 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “One bounded repair” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "habitat-twin": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 13,
    "total": 13,
    "artifactNodeId": "repair",
    "sourceSHA256": "4f649c3962e21cc366c805d6e389261a301a9f750f5992c0a97842c6e142c6e2",
    "nodes": {
      "assets": "done",
      "geometry": "done",
      "sensors": "done",
      "energy": "done",
      "maintenance": "done",
      "controls": "done",
      "scenarios": "done",
      "build": "done",
      "math-check": "done",
      "ux-check": "done",
      "repair": "done",
      "accept": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 13/13 个节点全部完成，模型为 Claude Opus 5.5。画布里的媒体节点在同一次运行中生成了 1 个 3D 模型的渲染图，页面直接使用。右侧是「一次跨视图修复」节点交付的原始页面，未做修改。",
      "en": "All 13/13 workflow nodes completed on Claude Opus 5.5. In the same run, the canvas's media nodes generated a 3D model's render, which the page shows. The right pane is the original page that the “One cross-view repair pass” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错，1 张生成图片正常显示；依次按下前 4 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors, and its 1 generated picture shows; pressing its first 4 buttons in turn raised no errors."
    }
  },
  "commerce-ops": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 12,
    "total": 12,
    "artifactNodeId": "deliver",
    "sourceSHA256": "e133aef839912bb3af150f6a40244ae2290c049324e4c54246187e35a6a9ce48",
    "nodes": {
      "scope": "done",
      "data": "done",
      "model": "done",
      "ux": "done",
      "engine": "done",
      "views": "done",
      "build": "done",
      "checks": "done",
      "repair": "done",
      "recheck": "done",
      "deliver": "done",
      "guide": "done"
    },
    "note": {
      "zh": "本次工作流 12/12 个节点全部完成，模型为 Claude Opus 5.5。右侧是「交付行业演示文件」节点交付的原始页面，未做修改。",
      "en": "All 12/12 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “Deliver the industry demonstration” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "model-foundry": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 12,
    "total": 12,
    "artifactNodeId": "repair",
    "sourceSHA256": "d14236db097b2ed31c870ba580bffa3b4fdc7cbf5a9db83e4e1ac9c456417ee6",
    "nodes": {
      "scope": "done",
      "data": "done",
      "train": "done",
      "metrics": "done",
      "drift": "done",
      "sweep": "done",
      "registry": "done",
      "build": "done",
      "verify": "done",
      "repair": "done",
      "retest": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 12/12 个节点全部完成，模型为 Claude Opus 5.5。右侧是「一次有界数值修复」节点交付的原始页面，未做修改。",
      "en": "All 12/12 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “One bounded numerical repair” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 5 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 5 buttons in turn raised no errors."
    }
  },
  "studio-pipeline": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 13,
    "total": 13,
    "artifactNodeId": "repair",
    "sourceSHA256": "37f417ca9366f484fe2e9e7a985e83c9e04004642c580dec2fa2a65e5cf70021",
    "nodes": {
      "brief": "done",
      "boards": "done",
      "timeline": "done",
      "assets": "done",
      "tasks": "done",
      "budget": "done",
      "preview": "done",
      "build": "done",
      "cut-check": "done",
      "production-check": "done",
      "repair": "done",
      "accept": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 13/13 个节点全部完成，模型为 Claude Opus 5.5。画布里的媒体节点在同一次运行中生成了 1 张配图、1 段样片，页面直接使用。右侧是「一次制作路径修复」节点交付的原始页面，未做修改。",
      "en": "All 13/13 workflow nodes completed on Claude Opus 5.5. In the same run, the canvas's media nodes generated 1 picture, 1 clip, which the page shows. The right pane is the original page that the “One production repair pass” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错，1 张生成图片和1 段样片正常显示、样片能播放；依次按下前 5 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors, and its 1 generated picture and 1 clip show (the clip plays); pressing its first 5 buttons in turn raised no errors."
    }
  },
  "factory-orchestrator": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 12,
    "total": 12,
    "artifactNodeId": "deliver",
    "sourceSHA256": "4499d00bfc2b560563914ebd767ae25ffec20188d62ec5646335d3c5311b671e",
    "nodes": {
      "scope": "done",
      "data": "done",
      "model": "done",
      "ux": "done",
      "engine": "done",
      "views": "done",
      "build": "done",
      "checks": "done",
      "repair": "done",
      "recheck": "done",
      "deliver": "done",
      "guide": "done"
    },
    "note": {
      "zh": "本次工作流 12/12 个节点全部完成，模型为 Claude Opus 5.5。右侧是「交付行业演示文件」节点交付的原始页面，未做修改。",
      "en": "All 12/12 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “Deliver the industry demonstration” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 5 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 5 buttons in turn raised no errors."
    }
  },
  "learning-campus": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 12,
    "total": 12,
    "artifactNodeId": "repair",
    "sourceSHA256": "3c875672cb7d41b03e821da337ffdd32529622a7ec142072364ecb997cc07075",
    "nodes": {
      "goal": "done",
      "curriculum": "done",
      "questions": "done",
      "mastery": "done",
      "planner": "done",
      "review": "done",
      "design": "done",
      "build": "done",
      "verify": "done",
      "repair": "done",
      "retest": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 12/12 个节点全部完成，模型为 Claude Opus 5.5。右侧是「一次有界教学修复」节点交付的原始页面，未做修改。",
      "en": "All 12/12 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “One bounded teaching-flow repair” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 5 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 5 buttons in turn raised no errors."
    }
  },
  "stay-revenue": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 13,
    "total": 13,
    "artifactNodeId": "repair",
    "sourceSHA256": "aa6998132f2236e9c9f61389c7b5aa1d27416f8395283fa54e4da62dbc6c0767",
    "nodes": {
      "scope": "done",
      "inventory": "done",
      "pricing": "done",
      "channels": "done",
      "booking": "done",
      "cancel": "done",
      "demand": "done",
      "interface": "done",
      "build": "done",
      "check": "done",
      "repair": "done",
      "accept": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 13/13 个节点全部完成，模型为 Claude Opus 5.5。画布里的媒体节点在同一次运行中生成了 1 张配图，页面直接使用。右侧是「一次预订链路修复」节点交付的原始页面，未做修改。",
      "en": "All 13/13 workflow nodes completed on Claude Opus 5.5. In the same run, the canvas's media nodes generated 1 picture, which the page shows. The right pane is the original page that the “One booking-path repair pass” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错，1 张生成图片正常显示；依次按下前 5 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors, and its 1 generated picture shows; pressing its first 5 buttons in turn raised no errors."
    }
  },
  "grid-balance": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 12,
    "total": 12,
    "artifactNodeId": "deliver",
    "sourceSHA256": "fad180150ff0315c6e5513671058db66df2048775f29303cceab59cdd9742d1a",
    "nodes": {
      "scope": "done",
      "data": "done",
      "model": "done",
      "ux": "done",
      "engine": "done",
      "views": "done",
      "build": "done",
      "checks": "done",
      "repair": "done",
      "recheck": "done",
      "deliver": "done",
      "guide": "done"
    },
    "note": {
      "zh": "本次工作流 12/12 个节点全部完成，模型为 Claude Opus 5.5。右侧是「交付行业演示文件」节点交付的原始页面，未做修改。",
      "en": "All 12/12 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “Deliver the industry demonstration” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "contract-desk": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 12,
    "total": 12,
    "artifactNodeId": "repair",
    "sourceSHA256": "08aa649a30548a289ca78f23abb9af60a56bae1180d16c6ffb1098db9ff348e8",
    "nodes": {
      "scope": "done",
      "versions": "done",
      "diff": "done",
      "rules": "done",
      "handling": "done",
      "timeline": "done",
      "reviewdata": "done",
      "build": "done",
      "verify": "done",
      "repair": "done",
      "retest": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 12/12 个节点全部完成，模型为 Claude Opus 5.5。右侧是「一次有界规则修复」节点交付的原始页面，未做修改。",
      "en": "All 12/12 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “One bounded rule repair” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "interaction-page": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 6,
    "total": 6,
    "artifactNodeId": "build",
    "sourceSHA256": "2a5a297d47d77e3c340a2ece34187cc7daa3f82aa123621585e9ca53af5e9675",
    "nodes": {
      "brief": "done",
      "copy": "done",
      "states": "done",
      "build": "done",
      "review": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 6/6 个节点全部完成，模型为 Claude Opus 5.5。画布里的媒体节点在同一次运行中生成了 1 张配图，页面直接使用。右侧是「页面合成」节点交付的原始页面，未做修改。",
      "en": "All 6/6 workflow nodes completed on Claude Opus 5.5. In the same run, the canvas's media nodes generated 1 picture, which the page shows. The right pane is the original page that the “Page assembly” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错，1 张生成图片正常显示；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors, and its 1 generated picture shows; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "orbit-game": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 6,
    "total": 6,
    "artifactNodeId": "build",
    "sourceSHA256": "2bf13374d263a1c08629e44604757dfd2a73bd0787ce998465eafe79d2ed51ed",
    "nodes": {
      "rules": "done",
      "mechanics": "done",
      "art": "done",
      "build": "done",
      "qa": "done",
      "release": "done"
    },
    "note": {
      "zh": "本次工作流 6/6 个节点全部完成，模型为 Claude Opus 5.5。画布里的媒体节点在同一次运行中生成了 1 张配图，页面直接使用。右侧是「可玩原型」节点交付的原始页面，未做修改。",
      "en": "All 6/6 workflow nodes completed on Claude Opus 5.5. In the same run, the canvas's media nodes generated 1 picture, which the page shows. The right pane is the original page that the “Playable prototype” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错，1 张生成图片正常显示；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors, and its 1 generated picture shows; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "spatial-studio": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 6,
    "total": 6,
    "artifactNodeId": "build",
    "sourceSHA256": "cb4ff0cf291f758c1064db388af4884cd771d161884aa7c46821f9808c4201ff",
    "nodes": {
      "scene": "done",
      "geometry": "done",
      "controls": "done",
      "build": "done",
      "review": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 6/6 个节点全部完成，模型为 Claude Opus 5.5。画布里的媒体节点在同一次运行中生成了 1 个 3D 模型的渲染图，页面直接使用。右侧是「空间工作台」节点交付的原始页面，未做修改。",
      "en": "All 6/6 workflow nodes completed on Claude Opus 5.5. In the same run, the canvas's media nodes generated a 3D model's render, which the page shows. The right pane is the original page that the “Spatial workbench” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错，1 张生成图片正常显示；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors, and its 1 generated picture shows; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "knowledge-desk": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 6,
    "total": 6,
    "artifactNodeId": "build",
    "sourceSHA256": "dc4363cfe25f2226a1de7e93e2144652db82da6521492d90e640aa5fb07b76f3",
    "nodes": {
      "corpus": "done",
      "index": "done",
      "eval": "done",
      "build": "done",
      "verify": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 6/6 个节点全部完成，模型为 Claude Opus 5.5。右侧是「可溯源检索界面」节点交付的原始页面，未做修改。",
      "en": "All 6/6 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “Traceable search interface” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 6 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 6 buttons in turn raised no errors."
    }
  },
  "model-lab": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 6,
    "total": 6,
    "artifactNodeId": "build",
    "sourceSHA256": "99bd2fa77c9506b51832819446e72235c4d1cc61076cb4a5044f906f8cd1f435",
    "nodes": {
      "dataset": "done",
      "trainer": "done",
      "metrics": "done",
      "build": "done",
      "check": "done",
      "card": "done"
    },
    "note": {
      "zh": "本次工作流 6/6 个节点全部完成，模型为 Claude Opus 5.5。右侧是「浏览器训练工作台」节点交付的原始页面，未做修改。",
      "en": "All 6/6 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “Browser training workbench” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 4 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 4 buttons in turn raised no errors."
    }
  },
  "operations-hub": {
    "model": "Claude Opus 5.5",
    "capturedOn": "2026-10-12",
    "completed": 6,
    "total": 6,
    "artifactNodeId": "build",
    "sourceSHA256": "4be544e275e1598d455f0c1b977983a91aaf53dfc413448663c82b07f603d53e",
    "nodes": {
      "schema": "done",
      "validation": "done",
      "rules": "done",
      "build": "done",
      "qa": "done",
      "handoff": "done"
    },
    "note": {
      "zh": "本次工作流 6/6 个节点全部完成，模型为 Claude Opus 5.5。右侧是「中台工作界面」节点交付的原始页面，未做修改。",
      "en": "All 6/6 workflow nodes completed on Claude Opus 5.5. The right pane is the original page that the “Operations console” node delivered, unmodified."
    },
    "verification": {
      "zh": "已在浏览器实测：打开即运行，没有脚本报错；依次按下前 1 个按钮后仍没有报错。",
      "en": "Browser-checked: it runs on open with no script errors; pressing its first 1 buttons in turn raised no errors."
    }
  },
};
