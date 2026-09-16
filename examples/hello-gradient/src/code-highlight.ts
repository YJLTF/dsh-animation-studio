/**
 * code 图层的语法高亮器。由 @dsh-anim/render-mc 生成，请勿手工编辑。
 *
 * @lezer/javascript 只导出单一 parser，TypeScript/JSX 通过 dialect 派生；
 * 其余语言各用独立解析器。LezerHighlighter 与 Code 组件同为实验性 API，
 * 但就是 3.17 的官方路径，渲染不受影响。
 */

import {LezerHighlighter} from '@motion-canvas/2d/lib/code';
import {parser as jsParser} from '@lezer/javascript';
import {parser as pythonParser} from '@lezer/python';
import {parser as jsonParser} from '@lezer/json';
import {parser as htmlParser} from '@lezer/html';
import {parser as cssParser} from '@lezer/css';

export const jsHighlighter = new LezerHighlighter(jsParser);
export const tsHighlighter = new LezerHighlighter(jsParser.configure({dialect: 'ts'}));
export const jsxHighlighter = new LezerHighlighter(jsParser.configure({dialect: 'jsx'}));
export const tsxHighlighter = new LezerHighlighter(jsParser.configure({dialect: 'ts + jsx'}));
export const pythonHighlighter = new LezerHighlighter(pythonParser);
export const jsonHighlighter = new LezerHighlighter(jsonParser);
export const htmlHighlighter = new LezerHighlighter(htmlParser);
export const cssHighlighter = new LezerHighlighter(cssParser);
