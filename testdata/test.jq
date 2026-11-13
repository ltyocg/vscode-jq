# F5 调试时自动打开的测试文件(见 .vscode/launch.json)
# 覆盖格式化的主要场景:管道、对象、def、if、注释
def top3(f):
  [.[] | {name, score: (f // 0)}]
    | sort_by(-.score)
    | .[0:3];

[
  .[] | select(.active)
    | {
      name: .user.name,
      tags: (.tags // []),
      score: (.points + .bonus // 0)
    }
]
  | top3(.score)
  | map(
    {
      # 行尾注释也会保留
      name,
      rank: (
        if .score >= 90 then "A"
        elif .score >= 75 then "B"
        else "C"
        end
      )
    }
  )
