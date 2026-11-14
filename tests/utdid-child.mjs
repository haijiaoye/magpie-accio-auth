// 并发测试用的子进程：打印本机 utdid（与主测试用同一个状态目录）。
import { utdidOf } from '../src/state.mjs'

process.stdout.write(utdidOf())
