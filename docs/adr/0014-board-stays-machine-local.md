# Board 保持 machine-local，跨机共享用文件同步而非 actor 化

mesh（ADR 0013）上线后，board（`~/.pi/xfer/board/`）理论上可迁到 actor state 实现跨机共享，但 board 的设计根基是"human orchestrates、agent 无需在线、无生命周期状态"（见 xfer CONTEXT.md），actor 化会把它变成另一种东西。决定 board 保持本地文件；确需跨机共享时用 syncthing 之类的目录同步，与 mesh 平行，零代码。
