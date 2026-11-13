/**
 * src/patent/figuregen/cad — FreeCAD 无头投影**脚本生成器**（纯函数，无 IO）。
 *
 * 用途：把一次投影请求（STEP 路径 + 视图集 + 剖切 + 锚点核对探针）渲染成一段自包含的
 * Python 源码，交给 `freecadcmd <script.py>` 执行；脚本只输出 JSON，**不画图、不产 SVG**
 * （画与交付契约归 Sati 侧，见 `render-cad.ts`）。
 *
 * **与 DSH 的对应关系**：DSH 的 `freecad-structure-script.ts` 同样是"纯函数生成 Python 源码"，
 * 同样把锚点核对放在脚本里（`verify_callout_owners` 按零件真实几何核对，容差 0.5mm），
 * 同样用"零件顺序即件号归属口径"。差异有两处，且都是有意为之：
 * - **投影内核不同**：DSH 用 `TechDraw::DrawViewPart` + `viewPartAsSvg`（GUI 文档对象），
 *   本模块用 `TechDraw.project`（纯函数式 API，可无头运行）——无头环境下 `DrawPage`
 *   文档对象不可靠，故 DSH 那条路在本仓不可直接复用；
 * - **多视图**：DSH 每次请求也只跑一次进程（多视图在同一脚本里循环），本模块同构：
 *   **一次 FreeCAD 运行产出全部视图**，避免每视图一个进程带来的性能与一致性损耗。
 *
 * **架构差异与理由**：本模块只生成"文本"，不做任何 IO 与解析（解析在 `freecad.ts`），
 * 于是"脚本长什么样"可在无 FreeCAD 的环境下单测；FreeCAD 的 API 事实（哪些属性存在、
 * 坐标朝向如何）则由本机实测固化在注释里。
 *
 * 实测事实（FreeCAD 1.1.3，`freecadcmd`，`App.GuiUp = 0`）：
 * - `Part.Shape().read(path)` 读回的是 **compound**，`shape.Solids` 给出逐零件实体；
 * - `solid.Area` / `solid.Volume` / `solid.CenterOfMass` / `solid.BoundBox` 均可用；
 * - `solid.distToShape(vertex)` 对**实体内部**的点返回 0（实体内 ⇒ 距离 0），
 *   故"到表面的距离"必须问**壳体**（`solid.Shells[0].distToShape`）：内部点得 3.0、
 *   表面点得 0.0、外部点得真实间距；
 * - `Part.export([shape], path)` 会**静默写出无几何的空壳 STEP**，导出须用
 *   `shape.exportStep(path)`；
 * - `TechDraw.project(shape, dir)` 返回 `[可见 G0, 可见 G1, 隐藏 G0, 隐藏 G1]`，
 *   输出数值即毫米（Y 已翻转 ⇒ 只需平移归一化）。
 */

import { CAD_ANCHOR_TOLERANCE_MM, CAD_PROJECTION_VERSION, type CadView } from "./types.js";
import { CAD_ERROR_MARKER } from "./error-marker.js";

/** 视图方向向量（FreeCAD 坐标系；front 为 -Y）。 */
export const CAD_VIEW_DIRECTIONS: Record<CadView, readonly [number, number, number]> = {
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  iso: [1, -1, 1],
};

/** 投影脚本生成参数。 */
export type ProjectionScriptOptions = {
  /** STEP 文件绝对路径。 */
  stepPath: string;
  /**
   * 单视图（既有调用方的入口；与 `views` 二选一，给了 `views` 时以 `views` 为准）。
   */
  view?: CadView;
  /** 请求的视图（顺序即输出顺序；第一个是主视图）。 */
  views?: readonly CadView[];
  /**
   * 剖切偏移（毫米）：**只作用于主视图**。
   *
   * 理由：剖切面垂直于视线方向，偏移量是"沿该视图方向的位置"；多视图各有一套方向，
   * 同一个数值在别的视图里指向不同的物理位置 ⇒ 只对主视图剖切，其余视图为整视图。
   */
  sectionOffsetMm?: number;
  /** 离散化容差（毫米）：越小越平滑、边表越大；0.5mm 对交付图足够。 */
  toleranceMm?: number;
  /**
   * 显式锚点探针（模型坐标，毫米）：脚本按零件真实几何核对每个点的归属。
   *
   * 与 DSH 同构（`verify_callout_owners`）：锚点错位是**输入错误**，应当在出图前报出来，
   * 而不是画完一张图再让人从图上看出来。
   */
  anchorProbes?: readonly (readonly [number, number, number])[];
};

/**
 * 生成投影脚本（Python）。
 *
 * **失败契约**：任何失败都写 stderr（`CAD_ERROR_MARKER` 前缀）并以 `sys.exit(1)` 结束；
 * 主流程收进 `_main()` 且由顶层兜底，使契约外的异常也不返回退出码 0
 * （实测 freecadcmd 对未捕获的 Python 异常退出码反而是 0 —— 见 `freecad.ts` 文件头注 5/6）。
 */
export function buildProjectionScript(options: ProjectionScriptOptions): string {
  const views = options.views ?? (options.view === undefined ? [] : [options.view]);
  if (views.length === 0) {
    throw new TypeError("投影视图集为空：至少要一个视图");
  }
  const tolerance = options.toleranceMm ?? 0.5;
  const section = options.sectionOffsetMm;
  const primary = views[0]!;
  if (section !== undefined) {
    // 剖切要求轴对齐视图（与 `freecad.ts` 的入参校验同口径，避免两处判定漂移）
    const direction = CAD_VIEW_DIRECTIONS[primary];
    const axisIndex = direction.findIndex(component => component !== 0);
    if (axisIndex === -1 || primary === "iso") {
      throw new TypeError(`视图 ${primary} 不能剖切（剖切要求轴对齐视图）`);
    }
  }
  const anchorProbes = options.anchorProbes ?? [];
  const helpers = [
    "def _fail(message):",
    "    # 不能用 raise SystemExit('…')：实测 freecadcmd 只传播退出码、吞掉消息；而非",
    "    # SystemExit 逃逸时退出码反而是 0。写 stderr + sys.exit(1) 是本机实测唯一",
    "    # 「消息与退出码同时成立」的形态；消费侧按 CAD_ERROR_MARKER 取真因。",
    "    sys.stderr.write(CAD_ERROR_MARKER + ' ' + str(message) + '\\n')",
    "    sys.stderr.flush()",
    "    sys.exit(1)",
    "",
    "def _discretize(edge):",
    "    length = edge.Length",
    "    count = int(max(2, min(64, length / TOLERANCE + 2)))",
    "    return [[round(p.x, 4), round(p.y, 4)] for p in edge.discretize(count)]",
    "",
    "# 投影坐标系是 TechDraw 自己挑的（实测 front 视图里 u 对应 -Z）：用四个单位参考体",
    "# （原点 + 三轴）分别投影，得到模型原点与各轴在投影平面上的像。仅有轴像不足以定出",
    "# 仿射映射（三轴像含同一个未知平移），故原点像必须一并给出。",
    "def _probe(vec, direction):",
    "    probe = Part.makeBox(0.001, 0.001, 0.001, vec)",
    "    p0, p1, _, _ = TechDraw.project(probe, direction)",
    "    probe_edges = list(p0.Edges) + list(p1.Edges)",
    "    if not probe_edges:",
    "        _fail('参考体投影为空，无法确定投影坐标系朝向')",
    "    point = probe_edges[0].discretize(2)[0]",
    "    return [round(point.x, 6), round(point.y, 6)]",
    "",
    "def _axes(direction):",
    "    return {",
    "        'origin': _probe(App.Vector(0, 0, 0), direction),",
    "        'x': _probe(App.Vector(1, 0, 0), direction),",
    "        'y': _probe(App.Vector(0, 1, 0), direction),",
    "        'z': _probe(App.Vector(0, 0, 1), direction),",
    "    }",
    "",
    "# 模型坐标 → 投影坐标（仿射；与 Sati 侧 `projectModelPoints` 同一映射，",
    "# FreeCAD 侧只用它算零件的投影包围盒与建议锚点，不重复实现投影口径）。",
    "def _to_uv(point, axes):",
    "    ox, oy = axes['origin']",
    "    u = ox + point.x * (axes['x'][0] - ox) + point.y * (axes['y'][0] - ox) + point.z * (axes['z'][0] - ox)",
    "    v = oy + point.x * (axes['x'][1] - oy) + point.y * (axes['y'][1] - oy) + point.z * (axes['z'][1] - oy)",
    "    return (u, v)",
    "",
    "# 剖切（全剖视图）：保留远离观者的一侧（p·d ≤ offset），露出剖切面。",
    "# 剖切面轮廓另行以**模型坐标**输出（Sati 侧投影 + 纸面剖面线填充）。",
    "def _section(shape, axis_index, sign, offset):",
    "    bb = shape.BoundBox",
    "    span = max(bb.XLength, bb.YLength, bb.ZLength, 1.0)",
    "    margin = span * 2 + 10",
    "    low = [bb.XMin - margin, bb.YMin - margin, bb.ZMin - margin]",
    "    high = [bb.XMax + margin, bb.YMax + margin, bb.ZMax + margin]",
    "    # 保留 sign*coord ≤ sign*offset 的一侧（远离观者）",
    "    if sign > 0:",
    "        high[axis_index] = offset",
    "    else:",
    "        low[axis_index] = offset",
    "    half = Part.makeBox(high[0]-low[0], high[1]-low[1], high[2]-low[2], App.Vector(low[0], low[1], low[2]))",
    "    kept = shape.common(half)",
    "    if kept.isNull() or not kept.Faces:",
    "        _fail('剖切后几何为空（剖切面在模型范围之外？offset=' + str(offset) + '）')",
    "    unit = App.Vector(0, 0, 0)",
    "    if axis_index == 0:",
    "        unit = App.Vector(sign, 0, 0)",
    "    elif axis_index == 1:",
    "        unit = App.Vector(0, sign, 0)",
    "    else:",
    "        unit = App.Vector(0, 0, sign)",
    "    faces = []",
    "    for face in kept.Faces:",
    "        if face.Surface.__class__.__name__ != 'Plane':",
    "            continue",
    "        normal = face.normalAt(0, 0)",
    "        if abs(normal.dot(unit) - 1.0) > 1e-6:",
    "            continue  # 非剖切面：法向须与视线方向一致（朝观者）",
    "        if abs(face.CenterOfMass.dot(unit) - offset * sign) > 1e-6:",
    "            continue",
    "        loops = []",
    "        wires = [face.OuterWire]",
    "        for wire in face.Wires:",
    "            if not wire.isSame(face.OuterWire):",
    "                loops.append(wire)",
    "        loops = [face.OuterWire] + loops",
    "        loops = [[[round(p.x, 4), round(p.y, 4), round(p.z, 4)] for p in _loop_points(w)] for w in loops]",
    "        faces.append({'loops': loops})",
    "    return kept, faces",
    "",
    "def _loop_points(wire):",
    "    # 环必须连成**闭合回路**：wire.OrderedEdges 只是「边集合已排序」，并不保证首尾相接地",
    "    # 串成走向（实测剖切面的边序是乱序）⇒ 按端点做连通性搜索逐边拼接，并在必要时反转",
    "    # （边的参数方向未必与环走向一致）。拼不成环即 fail-loud：宁可不输出，也不画错剖面线。",
    "    remaining = [list(e.discretize(int(max(2, min(64, e.Length / 0.2 + 2))))) for e in wire.Edges]",
    "    if not remaining:",
    "        _fail('剖切面轮廓环为空')",
    "    current = remaining.pop(0)",
    "    points = list(current)",
    "    end = current[-1]",
    "    while remaining:",
    "        found = None",
    "        for index, segment in enumerate(remaining):",
    "            if (segment[0] - end).Length <= 1e-6 or (segment[-1] - end).Length <= 1e-6:",
    "                found = index",
    "                break",
    "        if found is None:",
    "            _fail('剖切面轮廓环不闭合（边的端点接不上），拒绝输出可能错误的剖面线')",
    "        segment = remaining.pop(found)",
    "        if (segment[0] - end).Length > (segment[-1] - end).Length:",
    "            segment.reverse()",
    "        points.extend(segment)",
    "        end = points[-1]",
    "    if (points[0] - points[-1]).Length > 1e-3:",
    "        _fail('剖切面轮廓环未回到起点（几何异常），拒绝输出可能错误的剖面线')",
    "    return points",
    "",
    "# 零件表面采样点：顶点 + 边的离散点。全部落在**表面**上 ⇒ 建议锚点必在表面上。",
    "def _sample_points(solid):",
    "    points = []",
    "    for vertex in solid.Vertexes:",
    "        points.append(vertex.Point)",
    "    for edge in solid.Edges:",
    "        count = int(max(2, min(16, edge.Length / 1.0 + 2)))",
    "        for point in edge.discretize(count):",
    "            points.append(point)",
    "    return points",
    "",
    "# 到零件**表面**的距离：必须问壳体——实体对内部点返回 0（实体内 ⇒ 距离 0），",
    "# 那是「点是否落在实体内」的语义，不是「离表面多远」。",
    "def _surface_distance(solid, point):",
    "    vertex = Part.Vertex(point)",
    "    best = None",
    "    for shell in solid.Shells:",
    "        distance = shell.distToShape(vertex)[0]",
    "        if best is None or distance < best:",
    "            best = distance",
    "    if best is None:",
    "        return solid.distToShape(vertex)[0]",
    "    return best",
    "",
    "# 点到零件包围盒的距离（落在盒内为 0）。",
    "def _bbox_distance(bb, point):",
    "    dx = max(bb.XMin - point.x, 0.0, point.x - bb.XMax)",
    "    dy = max(bb.YMin - point.y, 0.0, point.y - bb.YMax)",
    "    dz = max(bb.ZMin - point.z, 0.0, point.z - bb.ZMax)",
    "    if dx == 0.0 and dy == 0.0 and dz == 0.0:",
    "        return 0.0",
    "    return math.sqrt(dx * dx + dy * dy + dz * dz)",
  ];
  const mainFlow = [
    "shape = Part.Shape()",
    "try:",
    "    shape.read(STEP_PATH)",
    "except Exception as exc:",
    "    _fail('STEP 文件不可读（不存在或格式不支持）: ' + STEP_PATH + ' [' + type(exc).__name__ + ': ' + str(exc) + ']')",
    "if shape.isNull():",
    "    _fail('STEP 已解析但几何为空（无 B-rep）: ' + STEP_PATH + ' —— 若该文件由脚本导出，请改用 shape.exportStep(path)：Part.export([shape], path) 会静默写出无几何的空壳 STEP')",
    "",
    "views = []",
    "axes_by_view = {}",
    "for VIEW, DIRECTION in VIEW_LIST:",
    "    table, axes = _project_view(shape, VIEW, DIRECTION, SECTION_OFFSETS.get(VIEW))",
    "    views.append(table)",
    "    axes_by_view[VIEW] = axes",
    "",
    "parts = _part_facts(shape)",
    "_attach_view_facts(shape, parts, axes_by_view)",
    "anchors = _anchor_checks(shape)",
    "",
    "payload = {",
    `    'version': ${CAD_PROJECTION_VERSION},`,
    "    'views': views,",
    "    'parts': parts,",
    "    'anchors': anchors,",
    "}",
    `print(${JSON.stringify("SATI_CAD_JSON_BEGIN")})`,
    "print(json.dumps(payload, ensure_ascii=False))",
    `print(${JSON.stringify("SATI_CAD_JSON_END")})`,
  ];
  const viewFlow = [
    "def _project_view(shape, name, direction, section_offset):",
    "    axis_index = 0",
    "    for index in range(3):",
    "        if (direction.x, direction.y, direction.z)[index] != 0:",
    "            axis_index = index",
    "            break",
    "    sign = 1 if direction.x + direction.y + direction.z > 0 else -1",
    "    projected = shape",
    "    cut_faces = []",
    "    if section_offset is not None:",
    "        projected, cut_faces = _section(shape, axis_index, sign, section_offset)",
    "",
    "    visible0, visible1, hidden0, hidden1 = TechDraw.project(projected, direction)",
    "    edges = []",
    "    kinds = {}",
    "    for kind, group in (('visible', visible0), ('visible', visible1), ('hidden', hidden0), ('hidden', hidden1)):",
    "        for edge in group.Edges:",
    "            points = _discretize(edge)",
    "            if len(points) < 2:",
    "                continue",
    "            curve = type(edge.Curve).__name__",
    "            kinds[curve] = kinds.get(curve, 0) + 1",
    "            edges.append({'kind': kind, 'curve': curve, 'closed': bool(edge.isClosed()), 'points': points})",
    "",
    "    if not edges:",
    "        _fail('投影未产生任何边（几何不可见或方向错误）: ' + name)",
    "",
    "    axes = _axes(direction)",
    "    table = {'view': name, 'units': 'mm', 'axes': axes, 'edges': edges, 'curveKinds': kinds}",
    "    if section_offset is not None:",
    "        axis_name = ('X', 'Y', 'Z')[axis_index]",
    "        lo = round(min(getattr(shape.BoundBox, axis_name + 'Min'), getattr(shape.BoundBox, axis_name + 'Max')), 4)",
    "        hi = round(max(getattr(shape.BoundBox, axis_name + 'Min'), getattr(shape.BoundBox, axis_name + 'Max')), 4)",
    "        signed = [lo, hi] if sign > 0 else [-hi, -lo]",
    "        table['section'] = {'offset_mm': section_offset, 'model_extent_mm': signed}",
    "        table['cutFaces'] = cut_faces",
    "    return table, axes",
    "",
    "def _part_facts(shape):",
    "    facts = []",
    "    for index, solid in enumerate(shape.Solids):",
    "        bb = solid.BoundBox",
    "        com = solid.CenterOfMass",
    "        facts.append({",
    "            'index': index,",
    "            'bbox': {",
    "                'min': [round(bb.XMin, 4), round(bb.YMin, 4), round(bb.ZMin, 4)],",
    "                'max': [round(bb.XMax, 4), round(bb.YMax, 4), round(bb.ZMax, 4)],",
    "            },",
    "            'centroid': [round(com.x, 4), round(com.y, 4), round(com.z, 4)],",
    "            'area': round(solid.Area, 4),",
    "            'volume': round(solid.Volume, 4),",
    "            'views': {},",
    "        })",
    "    return facts",
    "",
    "# 逐零件 × 逐视图的投影事实：投影包围盒 + 建议锚点（落在表面、投影位于轮廓外缘）。",
    "def _attach_view_facts(shape, facts, axes_by_view):",
    "    for index, solid in enumerate(shape.Solids):",
    "        samples = _sample_points(solid)",
    "        for view_name, axes in axes_by_view.items():",
    "            if not samples:",
    "                continue",
    "            projected = [_to_uv(point, axes) for point in samples]",
    "            min_u = min(item[0] for item in projected)",
    "            max_u = max(item[0] for item in projected)",
    "            min_v = min(item[1] for item in projected)",
    "            max_v = max(item[1] for item in projected)",
    "            center_u = (min_u + max_u) / 2.0",
    "            center_v = (min_v + max_v) / 2.0",
    "            best = 0",
    "            best_distance = -1.0",
    "            for position, item in enumerate(projected):",
    "                distance = (item[0] - center_u) ** 2 + (item[1] - center_v) ** 2",
    "                if distance > best_distance:",
    "                    best_distance = distance",
    "                    best = position",
    "            pick = samples[best]",
    "            facts[index]['views'][view_name] = {",
    "                'projectedBBox': {",
    "                    'min': [round(min_u, 4), round(min_v, 4)],",
    "                    'max': [round(max_u, 4), round(max_v, 4)],",
    "                },",
    "                'suggestedAnchor': [round(pick.x, 4), round(pick.y, 4), round(pick.z, 4)],",
    "                'suggestedAnchorProjected': [round(projected[best][0], 4), round(projected[best][1], 4)],",
    "            }",
    "",
    "# 显式锚点的归属核对：先表面（≤容差），再包围盒；都不命中即「不落在任何零件上」。",
    "def _anchor_checks(shape):",
    "    solids = list(shape.Solids)",
    "    if not solids:",
    "        return []",
    "    results = []",
    "    for probe in ANCHOR_PROBES:",
    "        point = App.Vector(probe[0], probe[1], probe[2])",
    "        surface = [_surface_distance(solid, point) for solid in solids]",
    "        boxes = [_bbox_distance(solid.BoundBox, point) for solid in solids]",
    "        owner = None",
    "        best_surface = None",
    "        for index, distance in enumerate(surface):",
    "            if distance <= ANCHOR_TOLERANCE and (best_surface is None or distance < best_surface):",
    "                best_surface = distance",
    "                owner = index",
    "        if owner is None:",
    "            best_box = None",
    "            for index, distance in enumerate(boxes):",
    "                if distance <= ANCHOR_TOLERANCE and (best_box is None or distance < best_box):",
    "                    best_box = distance",
    "                    owner = index",
    "        nearest = None",
    "        nearest_distance = None",
    "        for index, distance in enumerate(surface):",
    "            if nearest_distance is None or distance < nearest_distance:",
    "                nearest_distance = distance",
    "                nearest = index",
    "        entry = {",
    "            'point': [round(probe[0], 4), round(probe[1], 4), round(probe[2], 4)],",
    "            'ownerPart': owner,",
    "            'onPart': owner is not None,",
    "        }",
    "        if owner is not None:",
    "            entry['surfaceDistanceMm'] = round(surface[owner], 6)",
    "            entry['bboxDistanceMm'] = round(boxes[owner], 6)",
    "        if nearest is not None:",
    "            entry['nearestPart'] = nearest",
    "            entry['nearestSurfaceDistanceMm'] = round(surface[nearest], 6)",
    "        results.append(entry)",
    "    return results",
  ];
  const viewList = views
    .map(view => {
      const direction = CAD_VIEW_DIRECTIONS[view];
      return `    (${JSON.stringify(view)}, App.Vector(${direction[0]}, ${direction[1]}, ${direction[2]})),`;
    })
    .join("\n");
  const sectionOffsets = views
    .map((view, index) => `    ${JSON.stringify(view)}: ${index === 0 && section !== undefined ? section : "None"},`)
    .join("\n");
  const probeList = anchorProbes.map(probe => `    [${probe[0]}, ${probe[1]}, ${probe[2]}],`).join("\n");
  return [
    "# 由 Sati 生成（src/patent/figuregen/cad/freecad-script.ts）——只输出 JSON，不产出图形。",
    "import json",
    "import math",
    "import sys",
    "import FreeCAD as App",
    "import Part, TechDraw",
    "",
    `STEP_PATH = ${JSON.stringify(options.stepPath)}`,
    "VIEW_LIST = [",
    viewList,
    "]",
    "SECTION_OFFSETS = {",
    sectionOffsets,
    "}",
    `TOLERANCE = ${tolerance}`,
    `ANCHOR_TOLERANCE = ${CAD_ANCHOR_TOLERANCE_MM}`,
    "ANCHOR_PROBES = [",
    probeList,
    "]",
    `CAD_ERROR_MARKER = ${JSON.stringify(CAD_ERROR_MARKER)}`,
    "",
    ...helpers,
    "",
    ...viewFlow,
    "",
    "def _main():",
    ...mainFlow.map(line => (line.length === 0 ? "" : `    ${line}`)),
    "",
    "try:",
    "    _main()",
    "except Exception as exc:",
    "    _fail('未捕获异常（' + type(exc).__name__ + '）: ' + str(exc))",
    "",
  ].join("\n");
}
