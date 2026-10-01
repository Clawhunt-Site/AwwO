import { useEffect, useId, useMemo, useState } from 'react';
import { BookOpen, Check, ChevronRight, FlaskConical, Pause, Play, Plus, RotateCcw, Search, X } from 'lucide-react';
import { advanceTraining, createTrainingData, initialTrainingState, logisticProbability, searchKnowledge, type KnowledgeDocument, type TrainingSample } from './intelligenceMath';
import './intelligence-demos.css';

type DemoProps = { locale: 'zh' | 'en' };
const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

function knowledgeSeeds(locale: DemoProps['locale']): KnowledgeDocument[] {
  return locale === 'zh' ? [
    { id: 'KB-001', title: '交付与验收指南', content: '每次交付需要包含可运行成果、测试结果和已知限制。验收时先复现核心用户流程，再检查响应式布局与错误状态。验收通过后记录版本与负责人。' },
    { id: 'KB-002', title: '画布编排方法', content: '将目标拆成输入、并行制作、集成、验收四个阶段。画布节点明确角色和交付物，连线表示依赖。前端与数据逻辑可以并行，集成节点等待两项输出。' },
    { id: 'KB-003', title: '运营审批规则', content: '运营申请先由负责人检查预算和交付范围。预算不完整时驳回并补充资料。审批通过后进入执行队列，完成后附上验收证据。示例审批仅在当前页面生效。' },
    { id: 'KB-004', title: '训练实验记录', content: '模型训练前划分训练集和留出集。训练集用于梯度更新，留出集仅用于评估泛化。记录学习率、训练轮数、损失和准确率。噪声会降低可达到的准确率。' },
  ] : [
    { id: 'KB-001', title: 'Delivery and acceptance', content: 'Each delivery includes a working artifact, test results and known limitations. Acceptance starts with the core user journey, then responsive layout and error states. Record the version and owner after acceptance.' },
    { id: 'KB-002', title: 'Canvas orchestration', content: 'Split the goal into input, parallel creation, integration and acceptance. Canvas nodes specify roles and deliverables. Connections represent dependencies. Frontend and data logic run in parallel; integration waits for both outputs.' },
    { id: 'KB-003', title: 'Operations approval', content: 'The owner reviews the budget and delivery scope. Reject incomplete budgets and request missing details. Approved requests enter the execution queue and require acceptance evidence when complete. Demo approvals only affect this page.' },
    { id: 'KB-004', title: 'Training experiments', content: 'Split training data and held-out data before model training. Only the training split updates gradients. The held-out split evaluates generalization. Record learning rate, epochs, loss and accuracy. Label noise limits achievable accuracy.' },
  ];
}

export function KnowledgeDemo({ locale }: DemoProps) {
  return <KnowledgeWorkspace key={locale} locale={locale} />;
}

function KnowledgeWorkspace({ locale }: DemoProps) {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const [documents, setDocuments] = useState(() => knowledgeSeeds(locale));
  const [selectedId, setSelectedId] = useState('KB-001');
  const [title, setTitle] = useState(documents[0].title);
  const [content, setContent] = useState(documents[0].content);
  const [query, setQuery] = useState(t('交付验收', 'delivery acceptance'));
  const [activeQuery, setActiveQuery] = useState(query);
  const [threshold, setThreshold] = useState(0.06);
  const [emphasis, setEmphasis] = useState('');
  const [emphasisWeight, setEmphasisWeight] = useState(2);
  const [titleBoost, setTitleBoost] = useState(2);
  const [notice, setNotice] = useState('');
  const editorId = useId();
  const hits = useMemo(() => searchKnowledge(documents, activeQuery, { threshold, titleBoost, emphasis, emphasisWeight }), [documents, activeQuery, threshold, titleBoost, emphasis, emphasisWeight]);
  const selectDocument = (document: KnowledgeDocument) => { setSelectedId(document.id); setTitle(document.title); setContent(document.content); setNotice(''); };
  const reset = () => {
    const seeds = knowledgeSeeds(locale);
    setDocuments(seeds); selectDocument(seeds[0]); setQuery(t('交付验收', 'delivery acceptance')); setActiveQuery(t('交付验收', 'delivery acceptance'));
    setThreshold(0.06); setTitleBoost(2); setEmphasis(''); setEmphasisWeight(2); setNotice(t('已恢复样例知识库。', 'Sample library restored.'));
  };
  const saveDocument = () => {
    if (!title.trim() || !content.trim()) return;
    setDocuments(current => current.map(document => document.id === selectedId ? { ...document, title: title.trim(), content: content.trim() } : document));
    setNotice(t('文档已保存，索引与检索结果已更新。', 'Document saved. The index and results are updated.'));
  };
  const addDocument = () => {
    const document = { id: `KB-${String(documents.length + 1).padStart(3, '0')}`, title: t('新文档', 'New document'), content: '' };
    setDocuments(current => [...current, document]); selectDocument(document);
  };
  return <div className="official-demo official-demo-intelligence official-demo-knowledge">
    <div className="official-demo-intel-header">
      <div><span className="official-demo-eyebrow">KNOWLEDGE STUDIO</span><h3>{t('让每一次检索，都有出处', 'Every result has a source')}</h3></div>
      <button type="button" className="official-demo-quiet" onClick={reset}><RotateCcw size={14} />{t('重置', 'Reset')}</button>
    </div>
    <p className="official-demo-intel-note">{t('本地词项检索演示 · TF-IDF + 余弦相似度 · 不调用语言模型，未命中时不生成答案。', 'Local lexical retrieval · TF-IDF + cosine similarity · No language model or generated answers.')}</p>
    <div className="official-demo-knowledge-layout">
      <div className="official-demo-intel-panel official-demo-library">
        <div className="official-demo-panel-heading"><h4><BookOpen size={15} />{t('知识来源', 'Sources')} <span>{documents.length}</span></h4><button type="button" className="official-demo-icon-label" onClick={addDocument} disabled={documents.length >= 12}><Plus size={14} />{t('添加', 'Add')}</button></div>
        <div className="official-demo-source-list" role="group" aria-label={t('选择文档', 'Select a document')}>
          {documents.map(document => <button type="button" key={document.id} aria-pressed={document.id === selectedId} onClick={() => selectDocument(document)}><span>{document.title}</span><small>{document.id}</small></button>)}
        </div>
        <div className="official-demo-doc-editor" id={editorId}>
          <label>{t('文档标题', 'Document title')}<input value={title} maxLength={80} onChange={event => setTitle(event.target.value)} /></label>
          <label>{t('正文 · 可直接编辑', 'Content · edit freely')}<textarea value={content} maxLength={6000} rows={5} onChange={event => setContent(event.target.value)} /></label>
          <button type="button" className="official-demo-primary" disabled={!title.trim() || !content.trim()} onClick={saveDocument}>{t('保存并更新索引', 'Save and reindex')}<ChevronRight size={14} /></button>
          <p className="official-demo-inline-status" role="status">{notice || t('最多 12 篇文档。切换案例、语言或刷新后恢复样例。', 'Up to 12 documents. Switching cases/languages or refreshing restores samples.')}</p>
        </div>
      </div>
      <div className="official-demo-intel-panel official-demo-retrieval">
        <form className="official-demo-search-form" onSubmit={event => { event.preventDefault(); setActiveQuery(query.trim()); }}>
          <label htmlFor={`${editorId}-query`}>{t('搜索你的知识库', 'Search your knowledge')}</label>
          <div><Search size={17} /><input id={`${editorId}-query`} value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder={t('输入问题或关键词', 'Enter a question or keyword')} /><button type="submit" className="official-demo-primary">{t('检索', 'Search')}</button></div>
        </form>
        <div className="official-demo-retrieval-controls">
          <label>{t('最低相关度', 'Minimum similarity')}<strong>{formatPercent(threshold)}</strong><input type="range" min="0" max="0.7" step="0.01" value={threshold} onChange={event => setThreshold(Number(event.target.value))} /></label>
          <label>{t('标题权重', 'Title weight')}<strong>{titleBoost.toFixed(1)}×</strong><input type="range" min="1" max="5" step="0.5" value={titleBoost} onChange={event => setTitleBoost(Number(event.target.value))} /></label>
          <label>{t('强调词项', 'Emphasize terms')}<input value={emphasis} maxLength={80} onChange={event => setEmphasis(event.target.value)} placeholder={t('如：验收', 'e.g. acceptance')} /></label>
          <label>{t('词项权重', 'Term weight')}<strong>{emphasisWeight.toFixed(1)}×</strong><input type="range" min="1" max="5" step="0.5" value={emphasisWeight} onChange={event => setEmphasisWeight(Number(event.target.value))} /></label>
        </div>
        <div className="official-demo-results-heading" role="status"><span>{t('检索结果', 'Results')}</span><small>{hits.length} {t('条来源', 'sources')}</small></div>
        <div className="official-demo-retrieval-results">
          {hits.length ? hits.map((hit, index) => <article className="official-demo-retrieval-hit" key={hit.document.id}>
            <div><button type="button" className="official-demo-citation" onClick={() => selectDocument(hit.document)} aria-controls={editorId}>[{index + 1}] {hit.document.title}</button><strong>{formatPercent(hit.score)}</strong></div>
            <p>{hit.document.content}</p>
            <footer><span>{hit.document.id}</span><span>{t('匹配', 'Matched')}: {hit.matchedTerms.join(' · ')}</span></footer>
          </article>) : <div className="official-demo-empty"><Search size={25} /><strong>{t('没有匹配来源', 'No matching sources')}</strong><p>{t('换一个关键词、降低阈值，或添加相关文档。', 'Try another keyword, lower the threshold, or add a relevant document.')}</p></div>}
        </div>
        <p className="official-demo-method-note">{t('相关度是词项相似度，不代表答案正确率。中文使用相邻双字词项，英文使用单词；暂不支持语义同义词。', 'Similarity measures term overlap, not answer correctness. Chinese uses adjacent character pairs; English uses words. Semantic synonyms are not supported.')}</p>
      </div>
    </div>
  </div>;
}

function lossPath(history: TrainingSample[], split: 'train' | 'validation', maxLoss: number, maxEpoch: number): string {
  return history.map((sample, index) => `${index ? 'L' : 'M'}${(32 + sample.epoch / maxEpoch * 268).toFixed(2)},${(132 - sample[split].loss / maxLoss * 106).toFixed(2)}`).join(' ');
}

export function TrainingDemo({ locale }: DemoProps) {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const [rate, setRate] = useState(0.2);
  const [epochs, setEpochs] = useState(120);
  const [noise, setNoise] = useState(0.08);
  const data = useMemo(() => createTrainingData(noise), [noise]);
  const [model, setModel] = useState(() => initialTrainingState(data));
  const [running, setRunning] = useState(false);
  const [cpu, setCpu] = useState(72);
  const [queue, setQueue] = useState(64);
  useEffect(() => { setModel(initialTrainingState(data)); setRunning(false); }, [data]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setModel(current => advanceTraining(current, data, rate, Math.min(4, Math.max(0, epochs - current.epoch)))), 30);
    return () => window.clearInterval(timer);
  }, [running, data, rate, epochs]);
  useEffect(() => { if (running && model.epoch >= epochs) setRunning(false); }, [model.epoch, epochs, running]);
  const metrics = model.history[model.history.length - 1];
  const probability = logisticProbability(model.weights, cpu / 50 - 1, queue / 50 - 1);
  const maxLoss = Math.max(0.8, ...model.history.flatMap(sample => [sample.train.loss, sample.validation.loss]));
  const chartMaxEpoch = Math.max(epochs, model.epoch, 1);
  const reset = () => { setRunning(false); setRate(0.2); setEpochs(120); setNoise(0.08); setModel(initialTrainingState(createTrainingData(0.08))); setCpu(72); setQueue(64); };
  const resetModel = () => { setRunning(false); setModel(initialTrainingState(data)); };
  return <div className="official-demo official-demo-intelligence official-demo-training">
    <div className="official-demo-intel-header"><div><span className="official-demo-eyebrow">MODEL LAB / 001</span><h3>{t('在浏览器里，真正训练一个模型', 'Train a real model in your browser')}</h3></div><button type="button" className="official-demo-quiet" onClick={reset}><RotateCcw size={14} />{t('重置实验', 'Reset')}</button></div>
    <p className="official-demo-intel-note">{t('轻量逻辑回归实训 · 合成服务器负载数据 · 非大模型微调 · 所有指标来自当前实际计算。', 'Lightweight logistic regression · Synthetic server load data · Not LLM fine-tuning · All metrics are computed live.')}</p>
    <div className="official-demo-training-layout">
      <div className="official-demo-intel-panel official-demo-training-config">
        <h4><FlaskConical size={16} />{t('实验配置', 'Experiment')}</h4>
        <div className="official-demo-dataset-summary"><span>180 <small>{t('训练样本', 'training')}</small></span><span>60 <small>{t('留出样本', 'held out')}</small></span></div>
        <label>{t('学习率', 'Learning rate')}<strong>{rate.toFixed(2)}</strong><input type="range" min="0.01" max="1" step="0.01" value={rate} disabled={running} onChange={event => { setRate(Number(event.target.value)); resetModel(); }} /></label>
        <label>{t('训练轮数', 'Epochs')}<strong>{epochs}</strong><input type="range" min="20" max="300" step="20" value={epochs} disabled={running} onChange={event => { setEpochs(Number(event.target.value)); resetModel(); }} /></label>
        <label>{t('标签噪声', 'Label noise')}<strong>{Math.round(noise * 100)}%</strong><input type="range" min="0" max="0.35" step="0.01" value={noise} disabled={running} onChange={event => setNoise(Number(event.target.value))} /></label>
        <button type="button" className="official-demo-primary official-demo-training-run" onClick={() => { if (running) setRunning(false); else { setModel(initialTrainingState(data)); setRunning(true); } }}>{running ? <Pause size={15} /> : <Play size={15} />}{running ? t('停止训练', 'Stop training') : model.epoch ? t('重新训练', 'Train again') : t('开始训练', 'Start training')}</button>
        <div className="official-demo-training-progress" role="progressbar" aria-label={t('训练进度', 'Training progress')} aria-valuemin={0} aria-valuemax={epochs} aria-valuenow={model.epoch}><span style={{ width: `${Math.min(100, model.epoch / epochs * 100)}%` }} /></div>
        <p className="official-demo-training-status" role="status">{running ? t('正在梯度下降', 'Gradient descent running') : model.epoch >= epochs ? t('训练完成', 'Training complete') : model.epoch ? t('训练已停止', 'Training stopped') : t('等待训练', 'Ready to train')} · {model.epoch}/{epochs}</p>
        <p className="official-demo-method-note">{t('固定随机种子，可重复实验。仅训练集参与全批量梯度更新；留出集始终不参与更新。切换参数将清空本次模型。', 'A fixed seed makes runs reproducible. Only training data updates full-batch gradients; held-out data never does. Changing parameters clears the model.')}</p>
      </div>
      <div className="official-demo-training-results">
        <div className="official-demo-metric-grid">
          <div><span>{t('训练损失', 'Training loss')}</span><strong data-testid="training-loss">{metrics.train.loss.toFixed(4)}</strong><small>{t('交叉熵 · 越低越好', 'Cross entropy · lower is better')}</small></div>
          <div><span>{t('留出集损失', 'Held-out loss')}</span><strong>{metrics.validation.loss.toFixed(4)}</strong><small>{t('未参与梯度更新', 'Excluded from gradient updates')}</small></div>
          <div><span>{t('留出集准确率', 'Held-out accuracy')}</span><strong data-testid="validation-accuracy">{formatPercent(metrics.validation.accuracy)}</strong><small>{t('训练准确率', 'Train accuracy')} {formatPercent(metrics.train.accuracy)}</small></div>
        </div>
        <div className="official-demo-training-charts">
          <figure className="official-demo-intel-panel"><figcaption>{t('损失曲线', 'Loss over epochs')}<span><i />{t('训练', 'Train')}<i className="official-demo-legend-validation" />{t('留出', 'Held out')}</span></figcaption>
            <svg viewBox="0 0 320 155" role="img" aria-label={t('真实训练与留出集交叉熵曲线', 'Computed training and held-out cross-entropy curves')}>
              {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1="32" x2="300" y1={132 - fraction * 106} y2={132 - fraction * 106} stroke="currentColor" opacity=".1" /><text x="26" y={136 - fraction * 106} textAnchor="end">{(maxLoss * fraction).toFixed(1)}</text></g>)}
              <path d={lossPath(model.history, 'train', maxLoss, chartMaxEpoch)} fill="none" stroke="#317765" strokeWidth="2.5" /><path d={lossPath(model.history, 'validation', maxLoss, chartMaxEpoch)} fill="none" stroke="#a5774b" strokeWidth="2" strokeDasharray="4 3" />
              <circle cx="32" cy={132 - model.history[0].train.loss / maxLoss * 106} r="2" fill="#317765" /><text x="32" y="149">0</text><text x="300" y="149" textAnchor="end">{chartMaxEpoch} {t('轮', 'epochs')}</text>
            </svg>
          </figure>
          <figure className="official-demo-intel-panel"><figcaption>{t('决策区域', 'Decision surface')}<span>{t('实心训练 · 空心留出', 'Solid train · hollow held out')}</span></figcaption>
            <svg viewBox="0 0 320 155" role="img" aria-label={t('CPU 使用率与队列深度的样本及预测区域', 'Samples and predictions by CPU utilization and queue depth')}>
              {Array.from({ length: 144 }, (_, index) => { const x = index % 12; const y = Math.floor(index / 12); const p = logisticProbability(model.weights, (x + 0.5) / 6 - 1, (y + 0.5) / 6 - 1); return <rect key={index} x={36 + x * 21} y={122 - (y + 1) * 8.5} width="21" height="8.5" fill={p >= 0.5 ? '#dcad76' : '#87b8a3'} opacity={0.15 + Math.abs(p - 0.5) * 0.6} />; })}
              {data.train.map((point, index) => <circle key={`train-${index}`} cx={36 + (point.x + 1) * 126} cy={122 - (point.y + 1) * 51} r="1.65" fill={point.label ? '#a9753b' : '#317765'} opacity=".8" />)}
              {data.validation.map((point, index) => <circle key={`validation-${index}`} cx={36 + (point.x + 1) * 126} cy={122 - (point.y + 1) * 51} r="2.1" fill="none" stroke={point.label ? '#a9753b' : '#317765'} strokeWidth=".9" />)}
              <circle cx={36 + cpu / 100 * 252} cy={122 - queue / 100 * 102} r="4" fill="#fff" stroke="#242c2a" strokeWidth="2" /><text x="36" y="140">0%</text><text x="288" y="140" textAnchor="end">CPU 100%</text><text x="9" y="22">100</text><text x="9" y="122">0</text>
            </svg>
          </figure>
        </div>
        <div className="official-demo-intel-panel official-demo-prediction">
          <div><h4>{t('试一个新样本', 'Try an unseen sample')}</h4><p>{t('白色标记随输入移动', 'The white marker follows your input')}</p></div>
          <label>CPU <strong>{cpu}%</strong><input type="range" min="0" max="100" value={cpu} onChange={event => setCpu(Number(event.target.value))} /></label>
          <label>{t('队列深度', 'Queue depth')}<strong>{queue}</strong><input type="range" min="0" max="100" value={queue} onChange={event => setQueue(Number(event.target.value))} /></label>
          <div className="official-demo-prediction-result" aria-live="polite"><strong>{formatPercent(probability)}</strong><span>{t('高负载预测概率', 'Predicted high-load probability')}</span><small>{model.epoch ? probability >= 0.5 ? t('分类：高负载', 'Class: high load') : t('分类：正常', 'Class: normal') : t('模型尚未训练', 'Model is not trained yet')}</small></div>
        </div>
      </div>
    </div>
  </div>;
}

type RequestStatus = 'pending' | 'approved' | 'rejected' | 'complete';
type OperationsRequest = { id: string; name: [string, string]; owner: string; department: [string, string]; amount: number; status: RequestStatus; priority: 'high' | 'normal' };
const operationSeeds: OperationsRequest[] = [
  { id: 'OP-1042', name: ['产品发布页视觉制作', 'Launch page visual production'], owner: 'Alex', department: ['产品', 'Product'], amount: 4800, status: 'pending', priority: 'high' },
  { id: 'OP-1041', name: ['知识库内容更新', 'Knowledge library refresh'], owner: 'Mia', department: ['运营', 'Operations'], amount: 1600, status: 'pending', priority: 'normal' },
  { id: 'OP-1040', name: ['训练实验计算资源', 'Training compute resources'], owner: 'Noah', department: ['研发', 'Engineering'], amount: 3200, status: 'approved', priority: 'high' },
  { id: 'OP-1039', name: ['交互原型可用性测试', 'Prototype usability testing'], owner: 'Luna', department: ['设计', 'Design'], amount: 2400, status: 'pending', priority: 'normal' },
  { id: 'OP-1038', name: ['季度案例素材整理', 'Quarterly case materials'], owner: 'Evan', department: ['运营', 'Operations'], amount: 800, status: 'complete', priority: 'normal' },
  { id: 'OP-1037', name: ['活动预算补充申请', 'Additional event budget'], owner: 'Mia', department: ['运营', 'Operations'], amount: 6800, status: 'rejected', priority: 'high' },
];

export function OperationsDemo({ locale }: DemoProps) {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const localized = (text: [string, string]) => text[locale === 'zh' ? 0 : 1];
  const statuses: Record<RequestStatus, string> = { pending: t('待审批', 'Pending'), approved: t('已通过', 'Approved'), rejected: t('已驳回', 'Rejected'), complete: t('已完成', 'Complete') };
  const [requests, setRequests] = useState(() => operationSeeds.map(request => ({ ...request })));
  const [filter, setFilter] = useState<RequestStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('OP-1042');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [events, setEvents] = useState<{ id: number; text: string }[]>([]);
  const current = requests.find(request => request.id === selectedId)!;
  const visible = requests.filter(request => (filter === 'all' || request.status === filter) && [request.id, ...request.name, request.owner, ...request.department].join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const activeBudget = requests.filter(request => request.status === 'approved' || request.status === 'complete').reduce((sum, request) => sum + request.amount, 0);
  const reset = () => { setRequests(operationSeeds.map(request => ({ ...request }))); setFilter('all'); setSearch(''); setSelectedId('OP-1042'); setReason(''); setError(''); setEvents([]); };
  const transition = (status: RequestStatus) => {
    if ((current.status !== 'pending' || !['approved', 'rejected'].includes(status)) && !(current.status === 'approved' && status === 'complete')) return;
    if (status === 'rejected' && !reason.trim()) { setError(t('请填写驳回原因，方便申请人补充。', 'Add a rejection reason so the requester can follow up.')); return; }
    setRequests(items => items.map(item => item.id === current.id ? { ...item, status } : item));
    setEvents(items => [{ id: items.length + 1, text: `${current.id} · ${statuses[status]}${reason.trim() ? ` · ${reason.trim()}` : ''}` }, ...items]);
    setReason(''); setError('');
  };
  return <div className="official-demo official-demo-intelligence official-demo-operations">
    <div className="official-demo-intel-header"><div><span className="official-demo-eyebrow">OPERATIONS / WORKSPACE</span><h3>{t('从一笔申请，到交付闭环', 'From request to delivery')}</h3></div><button type="button" className="official-demo-quiet" onClick={reset}><RotateCcw size={14} />{t('重置数据', 'Reset data')}</button></div>
    <p className="official-demo-intel-note">{t('演示数据 · 审批、金额与记录仅在本次页面内存中流转，不发送通知或执行付款。', 'Demo data · Approvals, budgets and history exist only in this page session. No notifications or payments.')}</p>
    <div className="official-demo-ops-summary">
      <div><span>{t('待审批', 'Awaiting review')}</span><strong data-testid="operations-pending-count">{requests.filter(item => item.status === 'pending').length.toString().padStart(2, '0')}</strong><small>{t('进入审批工作台', 'Ready for review')}</small></div>
      <div><span>{t('执行中', 'In progress')}</span><strong>{requests.filter(item => item.status === 'approved').length.toString().padStart(2, '0')}</strong><small>{t('审批通过，等待完成', 'Approved, awaiting completion')}</small></div>
      <div><span>{t('已完成', 'Completed')}</span><strong>{requests.filter(item => item.status === 'complete').length.toString().padStart(2, '0')}</strong><small>{t('流程已闭环', 'Workflow closed')}</small></div>
      <div><span>{t('已批准预算', 'Approved budget')}</span><strong>¥{activeBudget.toLocaleString('en-US')}</strong><small>{t('包含已完成申请', 'Includes completed requests')}</small></div>
    </div>
    <div className="official-demo-ops-layout">
      <div className="official-demo-intel-panel official-demo-ops-board">
        <div className="official-demo-ops-toolbar"><h4>{t('申请队列', 'Request queue')}</h4><label><Search size={15} /><input aria-label={t('搜索申请', 'Search requests')} placeholder={t('搜索编号、事项、负责人', 'Search ID, request or owner')} value={search} onChange={event => setSearch(event.target.value)} /></label></div>
        <div className="official-demo-ops-filters" role="group" aria-label={t('申请状态筛选', 'Filter request status')}>
          {(['all', 'pending', 'approved', 'rejected', 'complete'] as const).map(status => <button type="button" key={status} aria-pressed={filter === status} onClick={() => setFilter(status)}>{status === 'all' ? t('全部', 'All') : statuses[status]}<span>{status === 'all' ? requests.length : requests.filter(item => item.status === status).length}</span></button>)}
        </div>
        <div className="official-demo-ops-table-wrap"><table className="official-demo-ops-table"><thead><tr><th>{t('事项 / 负责人', 'Request / owner')}</th><th>{t('预算', 'Budget')}</th><th>{t('状态', 'Status')}</th></tr></thead><tbody>
          {visible.map(request => <tr key={request.id} className={selectedId === request.id ? 'official-demo-selected-row' : ''}><td><button type="button" onClick={() => { setSelectedId(request.id); setReason(''); setError(''); }} aria-pressed={selectedId === request.id}><strong>{localized(request.name)}</strong><span>{request.id} · {request.owner} · {localized(request.department)}</span></button></td><td>¥{request.amount.toLocaleString('en-US')}</td><td><span className={`official-demo-status official-demo-status-${request.status}`}>{statuses[request.status]}</span></td></tr>)}
        </tbody></table>{!visible.length && <div className="official-demo-empty"><Search size={24} /><strong>{t('没有符合条件的申请', 'No matching requests')}</strong><p>{t('调整搜索关键词或状态筛选。', 'Try another search or status filter.')}</p></div>}</div>
        <p className="official-demo-table-count" role="status">{visible.length} / {requests.length} {t('条申请', 'requests')}</p>
      </div>
      <aside className="official-demo-intel-panel official-demo-approval-detail" aria-label={t('申请详情', 'Request detail')}>
        <span className="official-demo-eyebrow">{current.id} · {current.priority === 'high' ? t('优先处理', 'HIGH PRIORITY') : t('常规申请', 'NORMAL PRIORITY')}</span><h4>{localized(current.name)}</h4><span className={`official-demo-status official-demo-status-${current.status}`}>{statuses[current.status]}</span>
        <dl><div><dt>{t('申请人', 'Requester')}</dt><dd>{current.owner}</dd></div><div><dt>{t('部门', 'Department')}</dt><dd>{localized(current.department)}</dd></div><div><dt>{t('申请预算', 'Requested budget')}</dt><dd>¥{current.amount.toLocaleString('en-US')}</dd></div></dl>
        {current.status === 'pending' && <><label>{t('审批备注 · 驳回时必填', 'Review note · required to reject')}<textarea value={reason} maxLength={200} rows={3} placeholder={t('填写检查结论或需要补充的资料', 'Review findings or missing information')} onChange={event => { setReason(event.target.value); setError(''); }} /></label>{error && <p className="official-demo-error" role="alert">{error}</p>}<div className="official-demo-approval-actions"><button type="button" className="official-demo-primary" onClick={() => transition('approved')}><Check size={15} />{t('批准申请', 'Approve')}</button><button type="button" className="official-demo-secondary" onClick={() => transition('rejected')}><X size={15} />{t('驳回', 'Reject')}</button></div></>}
        {current.status === 'approved' && <button type="button" className="official-demo-primary" onClick={() => transition('complete')}><Check size={15} />{t('标记交付完成', 'Mark delivery complete')}</button>}
        {(current.status === 'complete' || current.status === 'rejected') && <p className="official-demo-method-note">{t('此申请已结束。重置演示数据可再次体验。', 'This request is closed. Reset demo data to try it again.')}</p>}
        <div className="official-demo-audit-log"><h5>{t('本次操作记录', 'Session activity')}</h5><ol aria-live="polite">{events.length ? events.map(event => <li key={event.id}>{event.text}</li>) : <li>{t('还没有操作。选择申请开始审批。', 'No activity yet. Select a request to review.')}</li>}</ol></div>
      </aside>
    </div>
  </div>;
}
